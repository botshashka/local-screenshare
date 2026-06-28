import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { createHub, SENDER_IDS, type Hub } from "../src/hub";

// These exercise the signaling hub at the socket level: real `ws` clients talk
// to a real WebSocketServer wired to a fresh createHub() per test. The focus is
// slot assignment, the prefer-reclaim that fixes the "no Share button" ghost
// bug, the close-guard that keeps a replaced socket from undoing its successor,
// and the heartbeat sweep.

let wss: WebSocketServer;
let hub: Hub;
let url: string;
const clients: TestClient[] = [];
// Server-side sockets in accept order, so a test can assert which socket the hub
// actually holds for a slot (hub.clients stores the server end, not the client).
let serverSockets: WebSocket[] = [];

// Boot a fresh hub + server. timeoutMs lets the reaping tests use a short
// liveness window so they can drive it with real time instead of waiting 30s.
async function boot(timeoutMs?: number): Promise<void> {
  if (wss) {
    for (const c of clients.splice(0)) c.raw.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
  hub = createHub(timeoutMs === undefined ? {} : { timeoutMs });
  serverSockets = [];
  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    serverSockets.push(ws);
    hub.handleConnection(ws);
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

beforeEach(() => boot());

afterEach(async () => {
  for (const c of clients.splice(0)) c.raw.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

interface Inbox {
  type: string;
  id?: string;
  [k: string]: unknown;
}

// A thin client wrapper that queues inbound frames and lets a test await the
// next frame matching a type (or any), with a short timeout so a missing
// message fails fast instead of hanging the suite.
interface TestClient {
  raw: WebSocket;
  // The hub's server-side socket for this client (what hub.clients stores).
  server: WebSocket;
  send(msg: object): void;
  next(type?: string, timeoutMs?: number): Promise<Inbox>;
  // Send a heartbeat ping and await the pong — a round-trip that deterministically
  // refreshes this socket's server-side last-seen just before a sweep.
  ping(): Promise<void>;
  closed(): Promise<{ code: number }>;
}

async function connect(): Promise<TestClient> {
  const before = serverSockets.length;
  const ws = new WebSocket(url);
  const inbox: Inbox[] = [];
  const waiters: { match: (m: Inbox) => boolean; resolve: (m: Inbox) => void }[] = [];

  ws.on("message", (raw: { toString(): string }) => {
    const msg = JSON.parse(raw.toString()) as Inbox;
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
    else inbox.push(msg);
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const client: TestClient = {
    raw: ws,
    // The server fires 'connection' before the client's 'open', so by now the
    // matching server socket is the one appended at our pre-connect index.
    server: serverSockets[before]!,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(type, timeoutMs = 1000) {
      const match = (m: Inbox): boolean => type === undefined || m.type === type;
      const found = inbox.findIndex(match);
      if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]!);
      return new Promise<Inbox>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${type ?? "any"} message`)),
          timeoutMs,
        );
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    async ping() {
      ws.send(JSON.stringify({ type: "ping" }));
      await this.next("pong");
    },
    closed() {
      return new Promise((resolve) => ws.once("close", (code: number) => resolve({ code })));
    },
  };
  clients.push(client);
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Assert no frame of `type` arrives within a short window (used for "the ghost's
// close must NOT emit peer-disconnected").
async function expectNo(client: TestClient, type: string): Promise<void> {
  await expect(client.next(type, 200)).rejects.toThrow(/timeout/);
}

describe("hub slot assignment", () => {
  it("assigns device-a then device-b by arrival order", async () => {
    const a = await connect();
    a.send({ type: "register", role: "sender" });
    expect((await a.next("assigned")).id).toBe("device-a");

    const b = await connect();
    b.send({ type: "register", role: "sender" });
    expect((await b.next("assigned")).id).toBe("device-b");

    expect(hub.clients.get("device-a")).toBe(a.server);
    expect(hub.clients.get("device-b")).toBe(b.server);
  });

  it("honors a free prefer hint", async () => {
    const a = await connect();
    a.send({ type: "register", role: "sender", prefer: "device-b" });
    expect((await a.next("assigned")).id).toBe("device-b");
  });

  it("turns a fresh third sender away with room-full (no stealing)", async () => {
    for (const _ of SENDER_IDS) {
      const s = await connect();
      s.send({ type: "register", role: "sender" });
      await s.next("assigned");
    }
    const third = await connect();
    third.send({ type: "register", role: "sender" });
    expect((await third.next()).type).toBe("room-full");
  });
});

describe("prefer reclaim (the 'no Share button' ghost bug)", () => {
  it("reclaims a slot still held by a ghost instead of returning room-full", async () => {
    // device-a genuinely connected; device-b held by a socket we leave open to
    // play the ghost (a half-open reload that hasn't closed yet).
    const a = await connect();
    a.send({ type: "register", role: "sender" });
    await a.next("assigned");

    const ghost = await connect();
    ghost.send({ type: "register", role: "sender" });
    expect((await ghost.next("assigned")).id).toBe("device-b");

    // The reloaded device reconnects preferring its old slot. Without reclaim it
    // would hit room-full (both slots look taken); with it, it gets device-b.
    const reconnect = await connect();
    reconnect.send({ type: "register", role: "sender", prefer: "device-b" });
    expect((await reconnect.next("assigned")).id).toBe("device-b");

    // The ghost socket is evicted, and the slot now points at the new socket.
    expect((await ghost.closed()).code).toBe(1000);
    expect(hub.clients.get("device-b")).toBe(reconnect.server);
  });

  it("does not grab a different free-looking slot when reclaiming", async () => {
    const ghost = await connect();
    ghost.send({ type: "register", role: "sender" });
    expect((await ghost.next("assigned")).id).toBe("device-a");

    // device-b is free, but a prefer:device-a reconnect must reclaim a, not hop.
    const reconnect = await connect();
    reconnect.send({ type: "register", role: "sender", prefer: "device-a" });
    expect((await reconnect.next("assigned")).id).toBe("device-a");
    expect((await ghost.closed()).code).toBe(1000);
  });
});

describe("token-gated reclaim (the two-tab 3s livelock)", () => {
  it("a different live device cannot evict a slot it also prefers", async () => {
    // device-a is held by a live tab. A *second* tab that also prefers device-a
    // (e.g. it once held that slot, so its client keeps preferring it) must NOT
    // evict the live one — that ping-pong is the 3s reconnect loop. It slots in
    // beside, on device-b.
    const a = await connect();
    a.send({ type: "register", role: "sender", token: "tab-1" });
    expect((await a.next("assigned")).id).toBe("device-a");

    const b = await connect();
    b.send({ type: "register", role: "sender", prefer: "device-a", token: "tab-2" });
    expect((await b.next("assigned")).id).toBe("device-b");

    // The live tab keeps its slot and its socket — no eviction took place.
    expect(hub.clients.get("device-a")).toBe(a.server);
    expect(hub.clients.get("device-b")).toBe(b.server);
  });

  it("a full room of distinct devices turns a third away, not evicts one", async () => {
    const a = await connect();
    a.send({ type: "register", role: "sender", token: "tab-1" });
    await a.next("assigned");
    const b = await connect();
    b.send({ type: "register", role: "sender", token: "tab-2" });
    await b.next("assigned");

    const third = await connect();
    third.send({ type: "register", role: "sender", prefer: "device-a", token: "tab-3" });
    expect((await third.next()).type).toBe("room-full");
    // Both incumbents survive.
    expect(hub.clients.get("device-a")).toBe(a.server);
    expect(hub.clients.get("device-b")).toBe(b.server);
  });

  it("still reclaims its own ghost when the token matches", async () => {
    // The legitimate reclaim: the same tab (same token) reconnecting over its
    // own half-open socket gets its slot back instead of being turned away.
    const ghost = await connect();
    ghost.send({ type: "register", role: "sender", token: "tab-1" });
    expect((await ghost.next("assigned")).id).toBe("device-a");

    const reconnect = await connect();
    reconnect.send({ type: "register", role: "sender", prefer: "device-a", token: "tab-1" });
    expect((await reconnect.next("assigned")).id).toBe("device-a");
    expect((await ghost.closed()).code).toBe(1000);
    expect(hub.clients.get("device-a")).toBe(reconnect.server);
  });
});

describe("close guard", () => {
  it("a replaced ghost's later close does not evict its successor", async () => {
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });

    const ghost = await connect();
    ghost.send({ type: "register", role: "sender" }); // device-a
    await ghost.next("assigned");
    await receiver.next("sender-connected");

    // Reclaim device-a with a new socket; the hub closes the ghost.
    const reconnect = await connect();
    reconnect.send({ type: "register", role: "sender", prefer: "device-a" });
    await reconnect.next("assigned");
    await receiver.next("sender-connected"); // re-paired against the new socket
    await ghost.closed();

    // The ghost's close must be a no-op: the slot still points at the successor,
    // and the receiver must NOT be told device-a disconnected.
    expect(hub.clients.get("device-a")).toBe(reconnect.server);
    await expectNo(receiver, "peer-disconnected");
  });
});

describe("pairing and relay", () => {
  it("pairs a sender that arrives before the receiver", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");

    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });

    expect((await receiver.next("sender-connected")).id).toBe("device-a");
    expect((await sender.next()).type).toBe("receiver-ready");
  });

  it("relays an addressed frame and stamps nothing it shouldn't drop", async () => {
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("receiver-ready");
    await receiver.next("sender-connected");

    sender.send({ type: "offer", to: "receiver", sdp: "v=0..." });
    const offer = await receiver.next("offer");
    expect(offer.sdp).toBe("v=0...");
  });

  it("drops an addressed frame when the target is absent", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    // No receiver registered; this must not throw or echo back.
    sender.send({ type: "offer", to: "receiver", sdp: "x" });
    await expectNo(sender, "offer");
  });
});

describe("disconnect", () => {
  it("notifies the receiver when a sender drops", async () => {
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    await receiver.next("sender-connected");

    sender.raw.close();
    expect((await receiver.next("peer-disconnected")).id).toBe("device-a");
    expect(hub.clients.has("device-a")).toBe(false);
  });

  it("notifies live senders when the receiver drops", async () => {
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("receiver-ready");

    receiver.raw.close();
    expect((await sender.next("peer-disconnected")).id).toBe("receiver");
  });
});

describe("liveness heartbeat", () => {
  it("replies to a ping with a pong", async () => {
    const c = await connect();
    c.send({ type: "ping" });
    expect((await c.next()).type).toBe("pong");
  });

  it("leaves a just-connected socket alone on sweep (now)", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    hub.sweep(); // real now — nothing is stale yet
    expect(hub.clients.has("device-a")).toBe(true);
  });

  it("reaps a silent socket and tells its peer it disconnected", async () => {
    await boot(50);
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    await receiver.next("sender-connected");

    await sleep(120); // the sender goes silent past the window…
    await receiver.ping(); // …the receiver stays alive to observe the eviction
    hub.sweep();

    expect((await receiver.next("peer-disconnected")).id).toBe("device-a");
    expect(hub.clients.has("device-a")).toBe(false);
    await sender.closed(); // terminated (1006), not a graceful close
  });

  it("reaps only the silent socket, sparing one that just pinged", async () => {
    await boot(50); // short liveness window
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    const live = await connect();
    live.send({ type: "register", role: "sender" }); // device-a, stays active
    await live.next("assigned");
    const ghost = await connect();
    ghost.send({ type: "register", role: "sender", prefer: "device-b" });
    await ghost.next("assigned");
    await receiver.next("sender-connected");
    await receiver.next("sender-connected");

    await sleep(120); // both senders now older than the 50ms window…
    await live.ping(); // …but this one refreshes via a ping round-trip
    await receiver.ping();
    hub.sweep();

    expect(hub.clients.has("device-a")).toBe(true); // the active one survives
    expect(hub.clients.has("device-b")).toBe(false); // the ghost is reaped
    expect((await receiver.next("peer-disconnected")).id).toBe("device-b");
  });

  it("a fresh sender reclaims a slot once the ghost holding it times out", async () => {
    await boot(50);
    const a = await connect();
    a.send({ type: "register", role: "sender" }); // device-a, kept alive
    await a.next("assigned");
    const ghost = await connect();
    ghost.send({ type: "register", role: "sender", prefer: "device-b" });
    await ghost.next("assigned");

    await sleep(120);
    await a.ping(); // a is still here

    // A genuinely new device (no prefer) registers. The sweep on register reaps
    // the timed-out ghost, freeing device-b for it — the exact "no Share button"
    // recovery: a fresh sender gets in instead of a permanent room-full.
    const fresh = await connect();
    fresh.send({ type: "register", role: "sender" });
    expect((await fresh.next("assigned")).id).toBe("device-b");
    await ghost.closed(); // the timed-out ghost was terminated
  });
});
