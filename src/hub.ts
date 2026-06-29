import type { WebSocket } from "ws";

// The signaling hub: slot assignment, SDP/ICE relay, and liveness. Extracted
// from the HTTP/cert/listen bootstrap in server.ts so the pairing logic can be
// driven by tests against real WebSockets. The Worker (worker/src/signaling.ts)
// is a faithful port of this same behavior onto Durable Objects.

export const SENDER_IDS = ["device-a", "device-b"] as const;
const RECEIVER = "receiver";

// Liveness. Clients send `{type:"ping"}` on HB_INTERVAL and we reply `{pong}`;
// any socket silent for longer than HB_TIMEOUT is reaped. This is an
// *application*-level heartbeat on purpose: a half-open or JS-frozen tab still
// answers protocol-level WebSocket pings at the OS/browser network layer, so a
// protocol ping can't tell a live page from a dead one. Requiring the page to
// send a message proves its JS is actually running. Reaping a ghost frees its
// sender slot (and tells the receiver), so a real device isn't blocked by it.
export const HB_INTERVAL_MS = 10_000;
export const HB_TIMEOUT_MS = 30_000;

export interface WsMsg {
  type: string;
  id?: string;
  role?: string;
  prefer?: string;
  token?: string;
  to?: string;
  from?: string;
  sdp?: string;
  candidate?: unknown;
  target?: { w: number; h: number };
}

// Sockets are tagged with the last time we heard anything from them, and with
// the per-tab `token` the client registered under (see the claim rule below).
type LiveSocket = WebSocket & { lastSeen?: number; token?: string };

const OPEN = 1; // WebSocket.OPEN — avoid importing the runtime enum into tests.

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
}

export interface Hub {
  // The single live socket per registered id. Exposed for assertions/tests.
  readonly clients: Map<string, WebSocket>;
  // Wire up one accepted connection (register/relay/close + liveness tagging).
  handleConnection(ws: WebSocket): void;
  // Reap every socket silent past HB_TIMEOUT_MS. Driven on an interval by the
  // server, and also run at register time so a reconnecting device sees a
  // freshly-cleaned slot map. `now` is injectable for tests.
  sweep(now?: number): void;
}

export function createHub(opts: { log?: (msg: string) => void; timeoutMs?: number } = {}): Hub {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? HB_TIMEOUT_MS;
  const clients = new Map<string, WebSocket>();
  // All open sockets, registered or not, so the sweep can reap a socket that
  // connected but never registered too.
  const sockets = new Set<WebSocket>();

  // Tell whoever is paired with `id` that it left. Shared by the close handler
  // and the liveness reaper so both routes notify identically.
  function announceGone(id: string): void {
    if (id === RECEIVER) {
      for (const sid of SENDER_IDS) {
        const sender = clients.get(sid);
        if (sender) send(sender, { type: "peer-disconnected", id: RECEIVER });
      }
    } else {
      const receiver = clients.get(RECEIVER);
      if (receiver) send(receiver, { type: "peer-disconnected", id });
    }
  }

  // Synchronously drop a socket: clear its slot, notify its peer, forget it, and
  // force it closed. Synchronous (vs. relying on the async 'close' event) so a
  // sweep that runs inside register() leaves a clean map for the slot logic.
  function reap(ws: WebSocket): void {
    sockets.delete(ws);
    for (const [id, sock] of clients) {
      if (sock !== ws) continue;
      clients.delete(id);
      log(`[-] ${id} (timed out)`);
      announceGone(id);
      break;
    }
    try {
      (ws as { terminate?: () => void }).terminate?.();
    } catch {
      // already gone
    }
  }

  function sweep(now = Date.now()): void {
    // reap() only deletes the socket passed to it (the current one), which is
    // safe to remove from the Set mid-iteration.
    for (const ws of sockets) {
      if (now - ((ws as LiveSocket).lastSeen ?? 0) > timeoutMs) reap(ws);
    }
  }

  function handleConnection(ws: WebSocket): void {
    let clientId: string | null = null;
    sockets.add(ws);
    (ws as LiveSocket).lastSeen = Date.now();

    ws.on("message", (raw: { toString(): string }) => {
      (ws as LiveSocket).lastSeen = Date.now();

      let msg: WsMsg;
      try {
        msg = JSON.parse(raw.toString()) as WsMsg;
      } catch {
        return;
      }

      // Liveness keepalive — the stamp above already recorded it; just ack so the
      // client knows its socket is two-way healthy (and reconnects if acks stop).
      if (msg.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (msg.type === "register") {
        // Clear any ghost slots first so a reconnecting device sees them free.
        sweep();

        // A socket may claim an id only if it's free or the current holder is
        // *this same tab* reconnecting — identified by the per-tab `token` the
        // client persists across reloads. This is what tells "reclaim my own
        // half-open ghost" apart from "evict a different live device": without
        // it the hub can't distinguish the two, so two tabs that both `prefer`
        // one slot would evict each other on every reconnect forever — a 3s
        // livelock. A tokenless client (token "") matches another tokenless
        // holder, preserving the original reclaim-always behavior for them.
        const token = typeof msg.token === "string" ? msg.token : "";
        const canClaim = (id: string): boolean => {
          const holder = clients.get(id) as LiveSocket | undefined;
          return !holder || holder === ws || (holder.token ?? "") === token;
        };

        if (msg.role === "receiver" || msg.id === RECEIVER) {
          // The receiver is singular (one TV per room) and intentionally
          // "newest wins": a TV reconnecting from any context takes the slot and
          // its own ghost's guarded close won't undo it. No token gate here —
          // unlike a sender it has no fallback slot, so refusing a reclaim could
          // strand a TV whose own ghost still holds the slot.
          clientId = RECEIVER;
        } else {
          // Honor a sender's `prefer` hint only when the slot is claimable
          // (free or our own ghost); otherwise fall back to any free slot, so a
          // different live device holding our preferred slot is slotted in
          // beside — never fought over. Both slots held by others ⇒ room-full.
          const prefer =
            typeof msg.prefer === "string" && (SENDER_IDS as readonly string[]).includes(msg.prefer)
              ? msg.prefer
              : null;
          const slot =
            (prefer && canClaim(prefer) ? prefer : null) ??
            SENDER_IDS.find((s) => !clients.has(s)) ??
            null;
          if (!slot) {
            send(ws, { type: "room-full" });
            return;
          }
          clientId = slot;
          send(ws, { type: "assigned", id: slot });
        }
        (ws as LiveSocket).token = token;
        // Evict any socket currently holding this id. canClaim above guarantees
        // it's either free or our own ghost, so this never drops a live peer.
        // The close handler below is guarded to only act for the socket that
        // still owns the slot, so closing the old one here won't undo this
        // registration or emit a stray peer-disconnected.
        const stale = clients.get(clientId);
        if (stale && stale !== ws) stale.close(1000, "replaced");
        // Drop any other slot this same socket already held, so re-registering
        // to a different slot can't leave it mapped under two ids (the Worker
        // can't hit this — it overwrites a single per-socket attachment).
        for (const [id, sock] of clients) {
          if (sock === ws && id !== clientId) clients.delete(id);
        }
        clients.set(clientId, ws);
        log(`[+] ${clientId}`);

        if (clientId === RECEIVER) {
          // Set up the receiver (sender-connected) before telling senders to
          // (re)offer (receiver-ready), so the receiver's peer connection exists
          // before an offer can arrive.
          for (const id of SENDER_IDS) {
            if (clients.has(id)) send(ws, { type: "sender-connected", id });
          }
          for (const id of SENDER_IDS) {
            const sender = clients.get(id);
            if (sender) send(sender, { type: "receiver-ready" });
          }
        } else {
          const receiver = clients.get(RECEIVER);
          if (receiver) {
            send(receiver, { type: "sender-connected", id: clientId });
            send(ws, { type: "receiver-ready" });
          }
        }
        return;
      }

      // Relay everything else to the addressed peer, stamping `from` with the
      // sender's own registered id — never trust a client-supplied `from`, and
      // drop a relay from a socket that hasn't registered. Mirrors the Worker.
      if (msg.to) {
        if (!clientId) return;
        const target = clients.get(msg.to);
        if (target) send(target, { ...msg, from: clientId });
      }
    });

    // Swallow per-socket errors so an abrupt drop can't surface as an unhandled
    // 'error' event; the 'close' that follows handles cleanup.
    ws.on("error", () => {});

    ws.on("close", () => {
      sockets.delete(ws);
      if (!clientId) return;
      // Only the socket that still owns this slot cleans up. A socket replaced on
      // re-registration (or already reaped) is a no-op here, so the live owner's
      // signaling isn't undone.
      if (clients.get(clientId) !== ws) return;
      clients.delete(clientId);
      log(`[-] ${clientId}`);
      announceGone(clientId);
    });
  }

  return { clients, handleConnection, sweep };
}
