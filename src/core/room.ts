// The signaling hub's decision logic — slot assignment, the token-gated claim
// rule, SDP/ICE relay, and liveness reaping — as runtime-agnostic pure functions.
//
// This is the SINGLE source of truth shared by both hub runtimes: the Node `ws`
// server (src/hub.ts) and the Cloudflare Durable Object (worker/src/signaling.ts)
// are thin adapters that build a Snapshot from their own socket storage, call
// these functions, and apply the returned ops. Keeping the logic here (instead of
// hand-mirroring it across two runtimes) is what makes it impossible for local and
// hosted deployments to silently diverge.
//
// Zero runtime imports on purpose: no `ws`, no node, no DOM, no workers-types — so
// it compiles unchanged under the server (CommonJS), worker (ESNext/bundler), and
// is importable by the browser test for the drift guard. Named exports only.

// ── Shared constants (the one definition; the client mirrors these in
// rtc-utils.ts, guarded by a drift test) ────────────────────────────────────
export const SENDER_IDS = ["device-a", "device-b"] as const;
export const RECEIVER = "receiver";

// A public hub is multi-tenant: one room per code, and the code is the only access
// gate — hence high entropy and an unambiguous alphabet (no 0/1/I/L/O). Length is
// fixed at 8, so the validation regex is derived from the alphabet+length.
export const ROOM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_LEN = 8;
export const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_LEN}}$`);

// Liveness: clients ping on HB_INTERVAL_MS; any socket silent past HB_TIMEOUT_MS is
// reaped, freeing its slot. The timeout is 3× the interval so one dropped ping is
// harmless. An *application*-level heartbeat is deliberate — a half-open or frozen
// tab still answers protocol-level pings, so only a message the page sends proves
// its JS is alive.
export const HB_INTERVAL_MS = 10_000;
export const HB_TIMEOUT_MS = 30_000;

// ── Types ───────────────────────────────────────────────────────────────────

// An opaque per-connection handle. The core only ever compares these by === — it
// never inspects, serializes, or persists one. The Node adapter passes its `ws`
// object; the Worker passes the hibernatable WebSocket.
export type ConnKey = object;

// Per-connection state the adapter stores and round-trips. `id` is null until the
// socket registers; `token` is the per-tab claim token; `seen` is the last time we
// heard from it (for reaping).
export interface Attach {
  id: string | null;
  seen: number;
  token: string;
}

// One connection as the core sees it: an opaque key plus its attachment.
export interface ConnView<K extends ConnKey = ConnKey> {
  key: K;
  attach: Attach;
}

// The room's full connection set, rebuilt by the adapter on each event.
export interface Snapshot<K extends ConnKey = ConnKey> {
  conns: ConnView<K>[];
}

// A decoded signaling frame. Only the fields the hub reads are named; the rest
// pass through on relay.
export interface SignalMsg {
  type: string;
  id?: string;
  role?: string;
  prefer?: string;
  token?: string;
  to?: string;
  from?: string;
  [key: string]: unknown;
}

// The effects the adapter applies, IN ORDER. The single ordered list is
// load-bearing: for a replaced/reaped connection the core emits its
// peer-disconnected `send`, then `attach` nulling its id, then `close` — applying
// them out of order would let a closing socket double-announce (its own close
// handler would still see it as registered). Adapters MUST apply ops in sequence.
export type Op<K extends ConnKey = ConnKey> =
  | { op: "send"; to: K; msg: object }
  | { op: "attach"; key: K; attach: Attach }
  | { op: "close"; key: K; kind: "reap" | "replace" };

export interface Effects<K extends ConnKey = ConnKey> {
  ops: Op<K>[];
}

const SENDER_ID_SET: ReadonlySet<string> = new Set(SENDER_IDS);

// ── Internal working model ──────────────────────────────────────────────────
// We copy the snapshot into mutable rows so reaps/registrations can update ids
// before later steps (slot search, relay targets) read them — mirroring how the
// Node hub mutates its `clients` map within a single event.
interface Row<K extends ConnKey> {
  key: K;
  id: string | null;
  token: string;
  seen: number;
  gone: boolean; // reaped or replaced this turn — excluded from all lookups
}

function rows<K extends ConnKey>(snap: Snapshot<K>): Row<K>[] {
  return snap.conns.map((c) => ({
    key: c.key,
    id: c.attach.id,
    token: c.attach.token,
    seen: c.attach.seen,
    gone: false,
  }));
}

function liveById<K extends ConnKey>(all: Row<K>[], id: string): Row<K> | undefined {
  return all.find((r) => !r.gone && r.id === id);
}

// Notify whoever is paired with a departing `id` that it left. Shared by reap and
// transport-close so both routes announce identically.
function announceGone<K extends ConnKey>(all: Row<K>[], id: string, ops: Op<K>[]): void {
  if (id === RECEIVER) {
    for (const r of all) {
      if (!r.gone && r.id !== null && r.id !== RECEIVER) {
        ops.push({ op: "send", to: r.key, msg: { type: "peer-disconnected", id: RECEIVER } });
      }
    }
  } else {
    const receiver = liveById(all, RECEIVER);
    if (receiver) ops.push({ op: "send", to: receiver.key, msg: { type: "peer-disconnected", id } });
  }
}

// Reap every row (except `except`) silent past the timeout: announce, null its
// attachment, force it closed. Mutates `all` (sets gone) so the rest of the event
// sees a clean set.
function reapSilent<K extends ConnKey>(
  all: Row<K>[],
  except: K,
  now: number,
  timeoutMs: number,
  ops: Op<K>[],
): void {
  for (const r of all) {
    if (r.gone || r.key === except) continue;
    if (now - r.seen <= timeoutMs) continue;
    if (r.id !== null) announceGone(all, r.id, ops);
    r.gone = true;
    ops.push({ op: "attach", key: r.key, attach: { id: null, seen: 0, token: "" } });
    ops.push({ op: "close", key: r.key, kind: "reap" });
  }
}

// ── Entry points ────────────────────────────────────────────────────────────

// Handle one decoded frame from `self`. Bumps self's last-seen, reaps silent
// peers, then dispatches ping / register / relay — the exact sequence both hubs
// hand-mirror today.
export function onMessage<K extends ConnKey>(
  snap: Snapshot<K>,
  self: K,
  msg: SignalMsg,
  now: number,
  timeoutMs: number = HB_TIMEOUT_MS,
): Effects<K> {
  const ops: Op<K>[] = [];
  const all = rows(snap);
  const me = all.find((r) => r.key === self);
  // The adapter only routes messages from sockets it knows; defensively no-op if
  // self isn't in the snapshot.
  if (!me) return { ops };

  // 1. Any message proves self's JS is alive — bump last-seen.
  me.seen = now;
  ops.push({ op: "attach", key: self, attach: { id: me.id, seen: now, token: me.token } });

  // 2. Reap peers gone silent, so a reconnecting device sees their slots free.
  reapSilent(all, self, now, timeoutMs, ops);

  // 3. Liveness keepalive — the stamp above recorded it; just ack.
  if (msg.type === "ping") {
    ops.push({ op: "send", to: self, msg: { type: "pong" } });
    return { ops };
  }

  if (msg.type === "register") {
    registerInto(all, me, msg, now, ops);
    return { ops };
  }

  // 4. Relay everything else to the addressed peer, stamping `from` with self's own
  // registered id — never trust a client-supplied `from`, and drop a relay from a
  // socket that hasn't registered.
  if (typeof msg.to === "string") {
    if (me.id === null) return { ops };
    const target = liveById(all, msg.to);
    if (target) ops.push({ op: "send", to: target.key, msg: { ...msg, from: me.id } });
  }
  return { ops };
}

function registerInto<K extends ConnKey>(
  all: Row<K>[],
  me: Row<K>,
  msg: SignalMsg,
  now: number,
  ops: Op<K>[],
): void {
  const token = typeof msg.token === "string" ? msg.token : "";

  // A socket may claim an id only if it's free or the current holder is *this same
  // tab* (matched by the per-tab token). This is what tells "reclaim my own
  // half-open ghost" apart from "evict a different live device" — without it two
  // tabs both preferring one slot would evict each other on every reconnect. A
  // tokenless client (token "") matches another tokenless holder, preserving the
  // original reclaim-always behavior.
  const canClaim = (id: string): boolean => {
    const holder = liveById(all, id);
    return !holder || holder.key === me.key || holder.token === token;
  };

  let clientId: string;
  if (msg.role === "receiver" || msg.id === RECEIVER) {
    // The receiver is singular and intentionally "newest wins": a TV reconnecting
    // from any context takes the slot. No token gate — unlike a sender it has no
    // fallback slot, so refusing a reclaim could strand a TV behind its own ghost.
    clientId = RECEIVER;
  } else {
    const prefer =
      typeof msg.prefer === "string" && SENDER_ID_SET.has(msg.prefer) ? msg.prefer : null;
    const free = SENDER_IDS.find((s) => !liveById(all, s)) ?? null;
    const slot = (prefer && canClaim(prefer) ? prefer : null) ?? free ?? null;
    if (!slot) {
      ops.push({ op: "send", to: me.key, msg: { type: "room-full" } });
      return;
    }
    clientId = slot;
    ops.push({ op: "send", to: me.key, msg: { type: "assigned", id: slot } });
  }

  // Evict any *other* socket holding this id. canClaim guaranteed it's free or our
  // own ghost, so this never drops a live peer. Null its attachment before closing
  // so its own close handler treats it as unregistered (no stray peer-disconnected).
  const stale = liveById(all, clientId);
  if (stale && stale.key !== me.key) {
    stale.gone = true;
    ops.push({ op: "attach", key: stale.key, attach: { id: null, seen: 0, token: "" } });
    ops.push({ op: "close", key: stale.key, kind: "replace" });
  }

  // Claim the slot. A single attach per socket means re-registering to a different
  // slot automatically frees the old one (no separate cleanup, unlike the Node map).
  me.id = clientId;
  me.token = token;
  ops.push({ op: "attach", key: me.key, attach: { id: clientId, seen: now, token } });

  // Re-sync state to whoever (re)joined — this is what lets the room survive peer
  // churn. Order matches the original: a receiver learns of senders (sets up its
  // peer connections) before senders are told to (re)offer.
  if (clientId === RECEIVER) {
    for (const s of SENDER_IDS) {
      if (liveById(all, s)) ops.push({ op: "send", to: me.key, msg: { type: "sender-connected", id: s } });
    }
    for (const s of SENDER_IDS) {
      const sender = liveById(all, s);
      if (sender) ops.push({ op: "send", to: sender.key, msg: { type: "receiver-ready" } });
    }
  } else {
    const receiver = liveById(all, RECEIVER);
    if (receiver) {
      ops.push({ op: "send", to: receiver.key, msg: { type: "sender-connected", id: clientId } });
      ops.push({ op: "send", to: me.key, msg: { type: "receiver-ready" } });
    }
  }
}

// Handle a transport close of `self`: announce its departure IFF it still owns its
// id. A socket replaced on re-registration or reaped (attachment already nulled)
// is a no-op here, so the live owner's signaling isn't undone and a reap doesn't
// double-announce.
export function onClose<K extends ConnKey>(snap: Snapshot<K>, self: K): Effects<K> {
  const ops: Op<K>[] = [];
  const all = rows(snap);
  const me = all.find((r) => r.key === self);
  if (!me || me.id === null) return { ops };
  // Exclude self from the announce targets (it's leaving).
  me.gone = true;
  announceGone(all, me.id, ops);
  return { ops };
}

// Standalone liveness pass — reap every silent socket. Driven on an interval by the
// Node server; the Worker reaps opportunistically inside onMessage instead.
export function sweep<K extends ConnKey>(
  snap: Snapshot<K>,
  now: number,
  timeoutMs: number = HB_TIMEOUT_MS,
): Effects<K> {
  const ops: Op<K>[] = [];
  const all = rows(snap);
  for (const r of all) {
    if (r.gone || now - r.seen <= timeoutMs) continue;
    if (r.id !== null) announceGone(all, r.id, ops);
    r.gone = true;
    ops.push({ op: "attach", key: r.key, attach: { id: null, seen: 0, token: "" } });
    ops.push({ op: "close", key: r.key, kind: "reap" });
  }
  return { ops };
}
