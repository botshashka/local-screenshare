// Cloudflare Worker + Durable Object signaling hub for screenshare.
//
// This is the *adapter* half: it routes each `wss://…/ws?room=CODE` connection to
// one Durable Object per room code, and the DO translates the WebSocket
// Hibernation API to/from the shared hub core (../../src/core/room.ts). All slot,
// claim, relay, and liveness DECISIONS live in that core — the same code the Node
// `ws` server (src/hub.ts) runs — so the local and hosted hubs can no longer
// drift. This file owns only the runtime glue: hibernation, the per-socket
// attachment store, and applying the core's ops to real sockets.
//
// Hibernation: an idle room costs nothing — the runtime evicts the instance while
// keeping sockets open, so per-connection state lives on each socket via
// serializeAttachment (which survives) rather than in instance memory (which
// doesn't). The core's snapshot is rebuilt from getWebSockets() + attachments on
// every event.

import {
  onMessage,
  onClose,
  ROOM_RE,
  WS_OPEN,
  type Attach,
  type Op,
  type SignalMsg,
  type Snapshot,
} from "../../src/core/room";

export interface Env {
  ROOMS: DurableObjectNamespace;
}

// Signaling frames are always JSON text; one decoder covers the rare binary case.
const DECODER = new TextDecoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const room = (url.searchParams.get("room") ?? "").trim().toUpperCase();
    if (!ROOM_RE.test(room)) {
      return new Response("Invalid or missing room code", { status: 400 });
    }
    // One DO instance per room code — derive it by name so the same code always
    // maps to the same hub, across reconnects and from any device.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  },
};

export class SignalingRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(_request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernatable accept — the runtime can evict this object between events while
    // keeping `server` open and delivering webSocket* callbacks.
    this.state.acceptWebSocket(server);
    // Connected but unregistered until it sends `register`.
    const fresh: Attach = { id: null, seen: Date.now(), token: "" };
    server.serializeAttachment(fresh);
    return new Response(null, { status: 101, webSocket: client });
  }

  private attachOf(ws: WebSocket): Attach {
    const a = ws.deserializeAttachment() as Partial<Attach> | null;
    return a && typeof a === "object"
      ? { id: a.id ?? null, seen: a.seen ?? 0, token: a.token ?? "" }
      : { id: null, seen: 0, token: "" };
  }

  // Rebuild the core's view from live sockets each event (instance fields don't
  // survive hibernation, but getWebSockets() + attachments do).
  private snapshot(): Snapshot<WebSocket> {
    const conns = this.state.getWebSockets().map((ws) => ({ key: ws, attach: this.attachOf(ws) }));
    return { conns };
  }

  // Apply the core's ops IN ORDER. The order matters: for a replaced/reaped socket
  // the core emits attach(id:null) before close, so the socket's own
  // webSocketClose sees it as unregistered and can't double-announce. Reaps and
  // replaces both close gracefully here — workerd has no terminate(), so 1000 is
  // the best primitive (the Node adapter uses terminate→1006 for a hard reap).
  private apply(ops: Op<WebSocket>[]): void {
    for (const op of ops) {
      if (op.op === "send") {
        try {
          if (op.to.readyState === WS_OPEN) op.to.send(JSON.stringify(op.msg));
        } catch {
          // A socket racing into close can throw; its close handler cleans up.
        }
      } else if (op.op === "attach") {
        try {
          op.key.serializeAttachment(op.attach);
        } catch {
          // gone
        }
      } else {
        try {
          op.key.close(1000, op.kind === "reap" ? "stale" : "replaced");
        } catch {
          // already closing
        }
      }
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: SignalMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : DECODER.decode(raw));
    } catch {
      return;
    }
    // The core bumps this socket's last-seen, reaps any silent peers (live peers
    // heartbeat often enough to trigger this — no timer needed, keeping the object
    // hibernation-friendly), then dispatches ping / register / relay.
    this.apply(onMessage(this.snapshot(), ws, msg, Date.now()).ops);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // A socket cleared on re-registration or reaping (attachment nulled) is a
    // no-op here, so the replacement's signaling isn't undone and a reap doesn't
    // double-announce.
    //
    // During webSocketClose the closing socket may already be gone from
    // getWebSockets(), but onClose needs to see `ws` (to read its id) — so ensure
    // it's in the snapshot. Its attachment is still readable on the closing socket.
    const snap = this.snapshot();
    if (!snap.conns.some((c) => c.key === ws)) {
      snap.conns.push({ key: ws, attach: this.attachOf(ws) });
    }
    this.apply(onClose(snap, ws).ops);
  }

  async webSocketError(): Promise<void> {
    // Swallow — the matching close handler does cleanup, as in the Node adapter.
  }
}
