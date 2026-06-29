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
  const inbox: Inbox[] = [];
  const waiters: { match: (m: Inbox) => boolean; resolve: (m: Inbox) => void }[] = [];

  // Open with a small retry. Tearing down and re-binding a `port: 0` server on
  // every test occasionally races the client handshake into a transient
  // connection error/400 under parallel-file load — recreating the socket keeps
  // the suite testing hub logic rather than ephemeral-port timing. The server
  // sends nothing until we register (after connect returns), so attaching the
  // message handler here can't miss a frame.
  let ws!: WebSocket;
  for (let attempt = 0; ; attempt++) {
    ws = new WebSocket(url);
    ws.on("message", (raw: { toString(): string }) => {
      const msg = JSON.parse(raw.toString()) as Inbox;
      const i = waiters.findIndex((w) => w.match(msg));
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
      else inbox.push(msg);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      break;
    } catch (err) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

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

// These are the Node `ws` *adapter* smoke tests: they prove createHub() correctly
// wires the shared core (src/core/room.ts) to real sockets and translates its ops
// — register/assigned, relay, close→peer-disconnected, the clients projection, and
// the one thing the pure core suite can't assert: a reap is a hard terminate
// (1006), not a graceful close. The exhaustive slot/claim/relay/liveness logic
// lives in test/core/room.test.ts.

describe("node adapter — pairing and relay", () => {
  it("registers a sender and replies assigned", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    expect((await sender.next("assigned")).id).toBe("device-a");
  });

  it("projects clients to the server socket holding each slot", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    expect(hub.clients.get("device-a")).toBe(sender.server);
  });

  it("relays an addressed frame, stamping from with the registered id (spoof ignored)", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    await receiver.next("sender-connected");

    sender.send({ type: "offer", to: "receiver", from: "device-b", sdp: "SDP" });
    const offer = await receiver.next("offer");
    expect(offer.from).toBe("device-a");
    expect(offer.sdp).toBe("SDP");
  });
});

describe("node adapter — disconnect & liveness", () => {
  it("replies to a ping with a pong", async () => {
    const c = await connect();
    c.send({ type: "ping" });
    expect((await c.next()).type).toBe("pong");
  });

  it("tells the peer when a socket closes", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    await receiver.next("sender-connected");

    sender.raw.close();
    expect((await receiver.next("peer-disconnected")).id).toBe("device-a");
  });

  it("a replaced ghost's later close does not evict its successor", async () => {
    // Same-token reclaim replaces the ghost; the core nulls the ghost's attachment
    // before closing it, so the adapter's close handler treats it as unregistered.
    const receiver = await connect();
    receiver.send({ type: "register", role: "receiver" });
    const ghost = await connect();
    ghost.send({ type: "register", role: "sender", prefer: "device-a", token: "tab" });
    await ghost.next("assigned");
    await receiver.next("sender-connected");

    const fresh = await connect();
    fresh.send({ type: "register", role: "sender", prefer: "device-a", token: "tab" });
    expect((await fresh.next("assigned")).id).toBe("device-a");
    await ghost.closed(); // the replaced socket is closed…
    await expectNo(receiver, "peer-disconnected"); // …but its close is a no-op
    expect(hub.clients.get("device-a")).toBe(fresh.server);
  });

  it("the interval sweep reaps a silent socket and frees its slot", async () => {
    await boot(50); // short liveness window
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    await sleep(120); // now older than the window
    hub.sweep();
    expect(hub.clients.has("device-a")).toBe(false);
    expect((await sender.closed()).code).toBe(1006); // terminated, not graceful
  });

  it("leaves a just-connected socket alone on sweep", async () => {
    const sender = await connect();
    sender.send({ type: "register", role: "sender" });
    await sender.next("assigned");
    hub.sweep();
    expect(hub.clients.has("device-a")).toBe(true);
  });
});

