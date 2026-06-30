import { describe, it, expect, afterEach } from "vitest";
import { SELF } from "cloudflare:test";

// These run inside workerd: each test opens real WebSocket upgrades against the
// Worker, which routes them to one SignalingRoom Durable Object per room code.
// This exercises the actual hibernation/attachment path — the same behaviors
// test/hub.test.ts checks for the Node port, asserted here against the real DO so
// the two implementations can't silently diverge.

interface Inbox {
  type: string;
  id?: string;
  from?: string;
  sdp?: string;
  [k: string]: unknown;
}

interface Client {
  send(msg: object): void;
  next(type?: string, timeoutMs?: number): Promise<Inbox>;
  ping(): Promise<void>;
  close(): void;
  closed(): Promise<{ code: number }>;
}

const open: Client[] = [];

// A distinct valid room code per test, so each maps to a fresh DO instance and
// no leftover sockets from a prior test bleed in. Any 4 chars from the alphabet
// satisfy the Worker's ROOM_RE.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
let roomCounter = 0;
function freshRoom(): string {
  let x = ++roomCounter;
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += ALPHABET[x % ALPHABET.length];
    x = Math.floor(x / ALPHABET.length) + 7; // keep digits varied across i
  }
  return code;
}

// `ip`, when given, is sent as CF-Connecting-IP — the Worker namespaces each room
// code by it, so two connections to the same code with different IPs land in
// different DOs (distinct LANs). Omitting it leaves connections in the shared
// `noip` scope, kept apart only by distinct codes.
async function connect(room: string, ip?: string): Promise<Client> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const res = await SELF.fetch(`https://hub.test/ws?room=${room}`, { headers });
  const ws = (res as unknown as { webSocket: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`expected a WebSocket upgrade, got status ${res.status}`);
  ws.accept();

  const inbox: Inbox[] = [];
  const waiters: { match: (m: Inbox) => boolean; resolve: (m: Inbox) => void; timer: number }[] = [];

  ws.addEventListener("message", (e: MessageEvent) => {
    const msg = JSON.parse(e.data as string) as Inbox;
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) {
      const w = waiters.splice(i, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });

  // Track close eagerly: the server can close us (replace/reap) before a test
  // gets around to awaiting it, so record the code and satisfy any pending wait.
  let closeCode: number | undefined;
  let onClose: ((code: number) => void) | undefined;
  ws.addEventListener("close", (e: CloseEvent) => {
    closeCode = e.code;
    onClose?.(e.code);
  });

  const client: Client = {
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(type, timeoutMs = 2000) {
      const match = (m: Inbox): boolean => type === undefined || m.type === type;
      const found = inbox.findIndex(match);
      if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]!);
      return new Promise<Inbox>((resolve, reject) => {
        const timer = setTimeout(() => {
          const wi = waiters.findIndex((w) => w.timer === timer);
          if (wi >= 0) waiters.splice(wi, 1);
          reject(new Error(`timeout waiting for ${type ?? "any"} message`));
        }, timeoutMs) as unknown as number;
        waiters.push({ match, resolve, timer });
      });
    },
    async ping() {
      ws.send(JSON.stringify({ type: "ping" }));
      await this.next("pong");
    },
    close: () => ws.close(),
    closed() {
      if (closeCode !== undefined) return Promise.resolve({ code: closeCode });
      return new Promise<{ code: number }>((resolve) => {
        onClose = (code) => resolve({ code });
      });
    },
  };
  open.push(client);
  return client;
}

// Assert no frame of `type` arrives within a short window.
async function expectNo(client: Client, type: string): Promise<void> {
  await expect(client.next(type, 300)).rejects.toThrow(/timeout/);
}

afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

describe("fetch routing", () => {
  it("404s a non-/ws path", async () => {
    const res = await SELF.fetch("https://hub.test/nope");
    expect(res.status).toBe(404);
  });

  it("426s a /ws request without the websocket upgrade header", async () => {
    const res = await SELF.fetch("https://hub.test/ws?room=K7P3");
    expect(res.status).toBe(426);
  });

  it("400s an invalid or missing room code", async () => {
    const bad = await SELF.fetch("https://hub.test/ws?room=nope", {
      headers: { Upgrade: "websocket" },
    });
    expect(bad.status).toBe(400);
    const missing = await SELF.fetch("https://hub.test/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(missing.status).toBe(400);
  });
});

describe("slot assignment", () => {
  it("assigns device-a then device-b by arrival order", async () => {
    const room = freshRoom();
    const a = await connect(room);
    a.send({ type: "register", role: "sender" });
    expect((await a.next("assigned")).id).toBe("device-a");

    const b = await connect(room);
    b.send({ type: "register", role: "sender" });
    expect((await b.next("assigned")).id).toBe("device-b");
  });

  it("honors a free prefer hint", async () => {
    const a = await connect(freshRoom());
    a.send({ type: "register", role: "sender", prefer: "device-b" });
    expect((await a.next("assigned")).id).toBe("device-b");
  });

  it("turns a fresh third sender away with room-full", async () => {
    const room = freshRoom();
    for (let i = 0; i < 2; i++) {
      const s = await connect(room);
      s.send({ type: "register", role: "sender" });
      await s.next("assigned");
    }
    const third = await connect(room);
    third.send({ type: "register", role: "sender" });
    expect((await third.next()).type).toBe("room-full");
  });

  it("isolates rooms: two codes are independent hubs", async () => {
    const a = await connect(freshRoom());
    a.send({ type: "register", role: "sender" });
    expect((await a.next("assigned")).id).toBe("device-a");
    // A different room's first sender is also device-a — separate DO instances.
    const b = await connect(freshRoom());
    b.send({ type: "register", role: "sender" });
    expect((await b.next("assigned")).id).toBe("device-a");
  });

  it("isolates by network: same code from different egress IPs are independent hubs", async () => {
    const room = freshRoom();
    const a = await connect(room, "203.0.113.1");
    a.send({ type: "register", role: "sender" });
    expect((await a.next("assigned")).id).toBe("device-a");
    // Same code, different LAN — its first sender is also device-a (separate DO).
    const b = await connect(room, "198.51.100.2");
    b.send({ type: "register", role: "sender" });
    expect((await b.next("assigned")).id).toBe("device-a");
  });

  it("shares a hub for the same code from the same egress IP", async () => {
    const room = freshRoom();
    const a = await connect(room, "203.0.113.1");
    a.send({ type: "register", role: "sender" });
    expect((await a.next("assigned")).id).toBe("device-a");
    // Same LAN, same code — a second sender slots in beside the first.
    const b = await connect(room, "203.0.113.1");
    b.send({ type: "register", role: "sender" });
    expect((await b.next("assigned")).id).toBe("device-b");
  });

  it("groups IPv6 by /64: same prefix shares a hub, different prefix does not", async () => {
    const room = freshRoom();
    // Two devices on one LAN's /64 (distinct addresses within it) → same hub.
    const a = await connect(room, "2001:db8:1:2::a");
    a.send({ type: "register", role: "sender" });
    expect((await a.next("assigned")).id).toBe("device-a");
    const b = await connect(room, "2001:db8:1:2:abcd::1");
    b.send({ type: "register", role: "sender" });
    expect((await b.next("assigned")).id).toBe("device-b");
    // A different /64 with the same code → independent hub (device-a again).
    const c = await connect(room, "2001:db8:9:9::a");
    c.send({ type: "register", role: "sender" });
    expect((await c.next("assigned")).id).toBe("device-a");
  });
});

describe("token-gated reclaim", () => {
  it("a different live device cannot evict a slot it also prefers", async () => {
    const room = freshRoom();
    const a = await connect(room);
    a.send({ type: "register", role: "sender", token: "tab-1" });
    expect((await a.next("assigned")).id).toBe("device-a");

    const b = await connect(room);
    b.send({ type: "register", role: "sender", prefer: "device-a", token: "tab-2" });
    expect((await b.next("assigned")).id).toBe("device-b"); // slots in beside, no evict
  });

  it("reclaims its own ghost when the token matches", async () => {
    const room = freshRoom();
    const ghost = await connect(room);
    ghost.send({ type: "register", role: "sender", token: "tab-1" });
    expect((await ghost.next("assigned")).id).toBe("device-a");

    const reconnect = await connect(room);
    reconnect.send({ type: "register", role: "sender", prefer: "device-a", token: "tab-1" });
    expect((await reconnect.next("assigned")).id).toBe("device-a");
    expect((await ghost.closed()).code).toBe(1000); // the ghost is replaced
  });
});

describe("pairing and relay", () => {
  it("pairs a sender that arrives before the receiver, receiver-first ordering", async () => {
    const room = freshRoom();
    const sender = await connect(room);
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");

    const receiver = await connect(room);
    receiver.send({ type: "register", role: "receiver" });
    expect((await receiver.next("sender-connected")).id).toBe("device-a");
    expect((await sender.next()).type).toBe("receiver-ready");
  });

  it("relays an addressed frame, stamping from with the registered id (spoof ignored)", async () => {
    const room = freshRoom();
    const receiver = await connect(room);
    receiver.send({ type: "register", role: "receiver" });
    const sender = await connect(room);
    sender.send({ type: "register", role: "sender" });
    await sender.next("receiver-ready");
    await receiver.next("sender-connected");

    sender.send({ type: "offer", to: "receiver", from: "receiver", sdp: "v=0..." });
    const offer = await receiver.next("offer");
    expect(offer.sdp).toBe("v=0...");
    expect(offer.from).toBe("device-a");
  });

  it("drops a relay from a socket that hasn't registered", async () => {
    const room = freshRoom();
    const receiver = await connect(room);
    receiver.send({ type: "register", role: "receiver" });
    const stranger = await connect(room);
    stranger.send({ type: "offer", to: "receiver", sdp: "x" });
    await expectNo(receiver, "offer");
  });
});

describe("disconnect", () => {
  it("notifies the receiver when a sender drops", async () => {
    const room = freshRoom();
    const receiver = await connect(room);
    receiver.send({ type: "register", role: "receiver" });
    const sender = await connect(room);
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    await receiver.next("sender-connected");

    sender.close();
    expect((await receiver.next("peer-disconnected")).id).toBe("device-a");
  });
});

describe("liveness", () => {
  it("replies to a ping with a pong", async () => {
    const c = await connect(freshRoom());
    c.send({ type: "ping" });
    expect((await c.next()).type).toBe("pong");
  });
});
