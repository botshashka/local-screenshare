// Pure receiver per-slot media-lifecycle controller. It sits ALONGSIDE the
// negotiation reducer (receiver-session.ts): that one answers offers; this one
// owns the *media* side of each sender slot — the <video>'s srcObject lifecycle,
// reveal-on-first-frame, the transient-flap vs real-loss reveal latch, and the
// re-offer retry. The adapter in receiver.ts performs the real RTCPeerConnection /
// MediaStream / DOM I/O and feeds results back here as gen-tagged events.
//
// `pcGen` is the negotiation epoch of the live PC for a slot. It is NOT a third
// generation counter — it's the same epoch the negotiation `create-pc` action
// already mints, threaded in so every media closure (ontrack, the reveal
// fallback, the liveness watcher, the retry timer) can be dropped when it belongs
// to a superseded PC. They share the value but stay separate state: the media gen
// advances only on `offer-arrived`, never on a negotiation `op-failed`.
//
// THE INVARIANT this module makes a tested rule rather than a comment: a slot's
// <video>.srcObject is nulled in EXACTLY ONE place — `peer-disconnected` (the hub
// says the sender truly left) — and (re)prepared in exactly one place —
// `offer-arrived` (a rebuild). It is NEVER touched on a transient connection drop
// or liveness loss, because when ICE self-heals the SAME track resumes and
// `ontrack` does not fire again; nulling on a flap would strand the slot blank
// until reload. The provenance tests assert these biconditionals. On a rebuild
// the adapter keeps the existing stream (last frame frozen) and lets `ontrack`
// swap the fresh track in, so a re-offer never flashes the frameless placeholder.
//
// `revealed` is a UI latch (the slot's "connected" state): set on the first
// decoded frame of the current gen, cleared only on a real loss
// (`liveness-lost`) or `peer-disconnected`. Crucially it is NOT reset on
// `offer-arrived` — so during a re-share/reconnect rebuild the slot stays
// "connected" and the room/QR card cannot flash up in the gap.

import { type Epoch } from "./session-protocol.js";

// Mirrors RTCPeerConnectionState minus "closed" (self-induced by our own
// pc.close(); the adapter never forwards it).
export type ConnPhase = "new" | "connecting" | "connected" | "disconnected" | "failed";

export interface SlotState {
  pcGen: Epoch; // negotiation epoch of the live PC; 0 = none / torn down
  conn: ConnPhase;
  revealed: boolean; // first-frame latch; NOT reset on rebuild
  retryPending: boolean;
}

export interface ReceiverControllerState {
  // One entry per sender slot that has ever been seen ("device-a" / "device-b").
  slots: Record<string, SlotState>;
}

export const initialReceiverControllerState: ReceiverControllerState = { slots: {} };

function emptySlot(): SlotState {
  return { pcGen: 0, conn: "new", revealed: false, retryPending: false };
}

function slotOf(state: ReceiverControllerState, id: string): SlotState {
  return state.slots[id] ?? emptySlot();
}

function withSlot(
  state: ReceiverControllerState,
  id: string,
  slot: SlotState,
): ReceiverControllerState {
  return { slots: { ...state.slots, [id]: slot } };
}

// A gen-tagged event is "current" only against a LIVE generation. pcGen 0 is the
// torn-down sentinel (set by peer-disconnected / initial), so nothing — not even
// a gen-0 event — counts as current against it; a dead slot ignores everything
// until the next offer-arrived re-bases its gen.
function isLiveGen(slot: SlotState, gen: Epoch): boolean {
  return slot.pcGen !== 0 && slot.pcGen === gen;
}

export type ReceiverControllerEvent =
  // A fresh offer arrived from sender `id`; `gen` is the epoch minted for its
  // rebuilt PC.
  | { t: "offer-arrived"; id: string; gen: Epoch }
  // The slot's PC advanced. `closed` is never forwarded (self-induced).
  | { t: "connection-changed"; id: string; gen: Epoch; state: ConnPhase }
  // A frame decoded (requestVideoFrameCallback / "playing").
  | { t: "frame-decoded"; id: string; gen: Epoch }
  // The post-connected reveal fallback timer elapsed.
  | { t: "reveal-fallback-fired"; id: string; gen: Epoch }
  // The liveness arbiter declared a real loss (post flap-vs-loss arbitration).
  | { t: "liveness-lost"; id: string; gen: Epoch }
  // The re-offer retry timer elapsed.
  | { t: "retry-fired"; id: string; gen: Epoch }
  // The hub says this sender genuinely left (not a transient flap).
  | { t: "peer-disconnected"; id: string };

export type ReceiverControllerAction =
  // Prepare the slot's <video> source for a rebuild. ONLY from offer-arrived.
  | { t: "reset-srcobject"; id: string }
  // <video>.srcObject = null. ONLY from peer-disconnected. THE single nulling.
  | { t: "null-srcobject"; id: string }
  | { t: "reveal-slot"; id: string }
  | { t: "mark-disconnected"; id: string }
  | { t: "schedule-reveal-fallback"; id: string; gen: Epoch }
  // Set jitterBufferTarget on the slot's receivers (I/O, but the controller owns
  // the "we entered connected" decision so it's testable).
  | { t: "tune-receivers"; id: string }
  | { t: "request-reoffer"; id: string }
  | { t: "schedule-retry"; id: string; gen: Epoch }
  | { t: "cancel-retry"; id: string }
  | { t: "stop-liveness"; id: string };

interface Result {
  state: ReceiverControllerState;
  actions: ReceiverControllerAction[];
}

export function receiverControllerReduce(
  state: ReceiverControllerState,
  event: ReceiverControllerEvent,
): Result {
  switch (event.t) {
    case "offer-arrived": {
      const prev = slotOf(state, event.id);
      // Rebuild: bump the gen and reset the element to a fresh stream, but carry
      // the `revealed` latch over untouched so the room card can't flash mid-build.
      const slot: SlotState = {
        pcGen: event.gen,
        conn: "connecting",
        revealed: prev.revealed,
        retryPending: false,
      };
      const actions: ReceiverControllerAction[] = [{ t: "reset-srcobject", id: event.id }];
      if (prev.retryPending) actions.push({ t: "cancel-retry", id: event.id });
      return { state: withSlot(state, event.id, slot), actions };
    }

    case "connection-changed": {
      const slot = slotOf(state, event.id);
      if (!isLiveGen(slot, event.gen)) return { state, actions: [] }; // superseded PC
      const next = { ...slot, conn: event.state };
      if (event.state === "connected") {
        const actions: ReceiverControllerAction[] = [];
        if (slot.retryPending) actions.push({ t: "cancel-retry", id: event.id });
        actions.push({ t: "tune-receivers", id: event.id });
        actions.push({ t: "schedule-reveal-fallback", id: event.id, gen: event.gen });
        return { state: withSlot(state, event.id, { ...next, retryPending: false }), actions };
      }
      // connecting / new / disconnected / failed: keep the last frame and let the
      // liveness arbiter (not raw connectionState) decide a real loss.
      return { state: withSlot(state, event.id, next), actions: [] };
    }

    case "frame-decoded": {
      const slot = slotOf(state, event.id);
      if (!isLiveGen(slot, event.gen) || slot.revealed) return { state, actions: [] };
      return {
        state: withSlot(state, event.id, { ...slot, revealed: true }),
        actions: [{ t: "reveal-slot", id: event.id }],
      };
    }

    case "reveal-fallback-fired": {
      const slot = slotOf(state, event.id);
      // Only reveal if this is still the current PC, it's actually connected, and
      // it isn't already revealed.
      if (!isLiveGen(slot, event.gen) || slot.revealed || slot.conn !== "connected") {
        return { state, actions: [] };
      }
      return {
        state: withSlot(state, event.id, { ...slot, revealed: true }),
        actions: [{ t: "reveal-slot", id: event.id }],
      };
    }

    case "liveness-lost": {
      const slot = slotOf(state, event.id);
      if (!isLiveGen(slot, event.gen)) return { state, actions: [] };
      const actions: ReceiverControllerAction[] = [{ t: "mark-disconnected", id: event.id }];
      let retryPending = slot.retryPending;
      if (!retryPending) {
        retryPending = true;
        actions.push({ t: "schedule-retry", id: event.id, gen: event.gen });
      }
      return { state: withSlot(state, event.id, { ...slot, revealed: false, retryPending }), actions };
    }

    case "retry-fired": {
      const slot = slotOf(state, event.id);
      if (!isLiveGen(slot, event.gen)) return { state, actions: [] };
      return {
        state: withSlot(state, event.id, { ...slot, retryPending: false }),
        actions: [{ t: "request-reoffer", id: event.id }],
      };
    }

    case "peer-disconnected": {
      const slot = slotOf(state, event.id);
      // The sender truly left: null the source (the ONE place), drop the slot to a
      // sentinel gen so any later stale gen-tagged event is ignored.
      const next: SlotState = { pcGen: 0, conn: "new", revealed: false, retryPending: false };
      const actions: ReceiverControllerAction[] = [
        { t: "null-srcobject", id: event.id },
        { t: "mark-disconnected", id: event.id },
        { t: "stop-liveness", id: event.id },
      ];
      if (slot.retryPending) actions.push({ t: "cancel-retry", id: event.id });
      return { state: withSlot(state, event.id, next), actions };
    }
  }
}

// ── Derived presentation ────────────────────────────────────────────────────
// The room/QR join card shows only when NO slot is revealed (first-frame latch),
// and only on a configured (multi-tenant) hub. Keyed on `revealed`, not `conn`,
// so it stays hidden across a rebuild (revealed persists) — no flash. The adapter
// applies this edge-triggered (start a grace timer on false→true, hide
// immediately on true→false), never re-arming the timer on an unchanged level.
export function wantRoomCard(state: ReceiverControllerState, hubConfigured: boolean): boolean {
  if (!hubConfigured) return false;
  return !Object.values(state.slots).some((s) => s.revealed);
}

// The edge-trigger decision the adapter applies. Acting only on a CHANGE (and
// never re-arming the grace timer while the level is unchanged) is what avoids
// the starvation bug where a per-tick recompute resets the show-timer forever so
// the card never appears. `prev` is null before the first call.
export type RoomCardEffect = "none" | "hide-now" | "show-deferred";
export function roomCardEffect(prev: boolean | null, want: boolean): RoomCardEffect {
  if (prev === want) return "none";
  return want ? "show-deferred" : "hide-now";
}
