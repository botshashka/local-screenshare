// Cloudflare Worker + Durable Object signaling hub for screenshare.
//
// This is a faithful port of the WebSocket relay in src/server.ts, made
// multi-tenant: the Worker routes each `wss://…/ws?room=CODE` connection to one
// Durable Object instance per room code (idFromName), and that DO is the room's
// signaling hub. It relays SDP/ICE between peers and never touches media — video
// flows peer-to-peer over the LAN exactly as before.
//
// The DO uses the WebSocket Hibernation API so an idle room costs nothing: the
// runtime evicts the instance while keeping sockets open, and per-connection
// identity is stored on each socket via serializeAttachment() rather than in
// instance memory (which doesn't survive hibernation).

export interface Env {
  ROOMS: DurableObjectNamespace;
}

// Mirrors ROOM_ALPHABET / validation in src/client/rtc-utils.ts. Kept inline so
// the Worker stays self-contained (no shared import across project boundaries);
// test/signaling.test.ts guards the two copies against drift.
const ROOM_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

// The display peer's id; every other id is a sender.
const RECEIVER = "receiver";

// The two sender slots, in arrival-assignment order. Mirrors SENDER_IDS in
// src/client/rtc-utils.ts. A registering sender is handed the first slot not
// already held by a live socket, so identity is owned by the hub, not chosen by
// the client — two people can't both claim Device A.
const SENDER_IDS = ["device-a", "device-b"] as const;

// Signaling frames are always JSON text; one decoder covers the rare binary case.
const DECODER = new TextDecoder();

// Liveness. Clients send `{type:"ping"}` on HB_INTERVAL_MS and we reply `{pong}`;
// any socket silent past HB_TIMEOUT_MS is reaped, freeing its sender slot. This
// is an *application*-level heartbeat on purpose: a half-open or JS-frozen tab
// still answers protocol-level pings at the OS/browser network layer, so only a
// message the page itself sends proves its JS is alive. No timers needed — the
// reap runs opportunistically on each incoming message (live peers heartbeat
// often enough to trigger it), which keeps the object hibernation-friendly.
// Mirrors HB_* in src/hub.ts.
const HB_TIMEOUT_MS = 30_000;

interface SignalMsg {
  type: string;
  id?: string;
  to?: string;
  from?: string;
  [key: string]: unknown;
}

// Per-socket state stored via serializeAttachment (survives hibernation): the
// registered id (null until `register`), the last time we heard from it, and
// the per-tab `token` it registered under (see the claim rule in register).
interface Attach {
  id: string | null;
  seen: number;
  token: string;
}

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
    // Hibernatable accept — the runtime can evict this object between events
    // while keeping `server` open and delivering webSocket* handler callbacks.
    this.state.acceptWebSocket(server);
    this.stamp(server, null);
    return new Response(null, { status: 101, webSocket: client });
  }

  private attachOf(ws: WebSocket): Attach {
    const a = ws.deserializeAttachment() as Partial<Attach> | null;
    return a && typeof a === "object"
      ? { id: a.id ?? null, seen: a.seen ?? 0, token: a.token ?? "" }
      : { id: null, seen: 0, token: "" };
  }

  // Record (or update) a socket's id and bump its last-seen to now, preserving
  // its registered token unless an explicit one is supplied (at register time).
  private stamp(ws: WebSocket, id: string | null, token?: string): void {
    const prev = this.attachOf(ws);
    ws.serializeAttachment({ id, seen: Date.now(), token: token ?? prev.token });
  }

  // Registered id of a socket, or null if it hasn't sent `register` yet.
  private idOf(ws: WebSocket): string | null {
    return this.attachOf(ws).id;
  }

  // Tell whoever is paired with `id` that it left. Shared by the close handler
  // and the liveness reaper so both routes notify identically.
  private announceGone(id: string, exclude?: WebSocket): void {
    if (id === RECEIVER) {
      for (const p of this.peers(exclude)) {
        if (p.id !== RECEIVER) this.send(p.ws, { type: "peer-disconnected", id: RECEIVER });
      }
    } else {
      const receiver = this.peers(exclude).find((p) => p.id === RECEIVER);
      if (receiver) this.send(receiver.ws, { type: "peer-disconnected", id });
    }
  }

  // Drop a silent socket: notify its peer, then clear its attachment (so it no
  // longer counts as registered for any logic this turn) and close it. Nulling
  // before close means its own webSocketClose won't double-announce.
  private reap(ws: WebSocket): void {
    const id = this.idOf(ws);
    if (id) this.announceGone(id, ws);
    try {
      ws.serializeAttachment({ id: null, seen: 0, token: "" });
      ws.close(1000, "stale");
    } catch {
      // already closing
    }
  }

  // Reap every socket (except the one we just heard from) that's gone silent
  // past the heartbeat timeout. Runs at the top of each message.
  private sweep(except: WebSocket, now: number): void {
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      if (now - this.attachOf(ws).seen > HB_TIMEOUT_MS) this.reap(ws);
    }
  }

  // The room's registered peers, rebuilt from live sockets each call (instance
  // fields don't survive hibernation, but getWebSockets() + attachments do).
  private peers(exclude?: WebSocket): { id: string; ws: WebSocket }[] {
    const out: { id: string; ws: WebSocket }[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      const id = this.idOf(ws);
      if (id) out.push({ id, ws });
    }
    return out;
  }

  private send(ws: WebSocket, msg: object): void {
    try {
      if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(msg));
    } catch {
      // A socket racing into close can throw; the close handler cleans up.
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // Any message proves this socket's JS is alive — bump its last-seen, then
    // reap any peers that have gone silent so a reconnecting device sees their
    // slots free.
    const now = Date.now();
    this.stamp(ws, this.idOf(ws));
    this.sweep(ws, now);

    let msg: SignalMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : DECODER.decode(raw));
    } catch {
      return;
    }

    // Liveness keepalive — the stamp above recorded it; just ack so the client
    // knows its socket is two-way healthy (and reconnects if acks stop).
    if (msg.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }

    if (msg.type === "register") {
      const others = this.peers(ws);

      // A socket may claim an id only if it's free or the current holder is
      // *this same tab* reconnecting — identified by the per-tab `token` the
      // client persists across reloads. This tells "reclaim my own half-open
      // ghost" apart from "evict a different live device": without it the hub
      // can't distinguish the two, so two tabs that both `prefer` one slot
      // would evict each other on every reconnect forever — a 3s livelock. A
      // tokenless client (token "") matches another tokenless holder, keeping
      // the original reclaim-always behavior for them. Mirrors src/hub.ts.
      const token = typeof msg.token === "string" ? msg.token : "";
      const canClaim = (slot: string): boolean => {
        const holder = others.find((p) => p.id === slot);
        return !holder || this.attachOf(holder.ws).token === token;
      };

      // Resolve this socket's id. The receiver keeps its fixed id; a sender is
      // assigned the first free slot (honoring an optional `prefer` hint for
      // reconnect stability), so the client never chooses — that's what stops a
      // second person from claiming a slot already in use.
      let id: string;
      if (msg.role === "receiver" || msg.id === RECEIVER) {
        // The receiver is singular (one TV per room) and intentionally "newest
        // wins": a TV reconnecting from any context takes the slot. No token
        // gate here — unlike a sender it has no fallback slot, so refusing a
        // reclaim could strand a TV whose own ghost still holds the slot.
        id = RECEIVER;
      } else {
        // Honor a sender's `prefer` hint only when the slot is claimable (free
        // or our own ghost); otherwise fall back to any free slot, so a
        // different live device holding our preferred slot is slotted in beside
        // — never fought over. Both slots held by others ⇒ room-full.
        const taken = new Set(others.map((p) => p.id));
        const prefer =
          typeof msg.prefer === "string" && (SENDER_IDS as readonly string[]).includes(msg.prefer)
            ? msg.prefer
            : null;
        const slot =
          (prefer && canClaim(prefer) ? prefer : null) ??
          SENDER_IDS.find((s) => !taken.has(s)) ??
          null;
        if (!slot) {
          this.send(ws, { type: "room-full" });
          return;
        }
        id = slot;
      }

      // Replace any stale socket holding this id. canClaim above guarantees it's
      // either free or our own ghost, so this never drops a live peer. Mirrors
      // the single-socket-per-id Map in server.ts so `to`-routing stays
      // unambiguous. Clear its attachment first so its close handler sees it as
      // unregistered and doesn't emit a peer-disconnected that races this
      // re-registration.
      for (const p of others) {
        if (p.id === id) {
          try {
            p.ws.serializeAttachment(null);
            p.ws.close(1000, "replaced");
          } catch {
            // ignore
          }
        }
      }
      this.stamp(ws, id, token);

      // Tell a sender which slot it got before any re-sync below, so it knows
      // its identity when a receiver-ready prompts it to offer.
      if (id !== RECEIVER) this.send(ws, { type: "assigned", id });

      // Re-sync state to whoever (re)joined — this is what lets the room survive
      // peer churn: any join re-pairs against everyone already present. Order
      // matches server.ts: a receiver learns of senders (sets up its peer
      // connections) before senders are told to (re)offer. `live` is the single
      // peer snapshot minus the stale same-id socket(s) just closed above.
      const live = others.filter((p) => p.id !== id);
      if (id === RECEIVER) {
        for (const s of live) this.send(ws, { type: "sender-connected", id: s.id });
        for (const s of live) this.send(s.ws, { type: "receiver-ready" });
      } else {
        const receiver = live.find((p) => p.id === RECEIVER);
        if (receiver) {
          this.send(receiver.ws, { type: "sender-connected", id });
          this.send(ws, { type: "receiver-ready" });
        }
      }
      return;
    }

    // Relay everything else to the addressed peer, stamping `from` with the
    // sender's own registered id — never trust a client-supplied `from` on a
    // public hub.
    if (typeof msg.to === "string") {
      const from = this.idOf(ws);
      if (!from) return;
      const target = this.peers().find((p) => p.id === msg.to);
      if (target) this.send(target.ws, { ...msg, from });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // A socket cleared on re-registration or reaping (attachment nulled) is
    // treated as unregistered here, so the replacement's signaling isn't undone
    // and a reap doesn't double-announce.
    const id = this.idOf(ws);
    if (id) this.announceGone(id, ws);
  }

  async webSocketError(): Promise<void> {
    // Swallow — the matching close handler does cleanup, as in server.ts.
  }
}
