// Pure sender-side negotiation reducer. The sender is always the *offerer*: it
// builds an offer, sends it to the receiver, applies the answer, and exchanges
// ICE. Like receiver-session, the decisions live here (testable) and the adapter
// in sender.ts performs the real RTCPeerConnection I/O, feeding results back as
// events.
//
// The invariants it enforces:
//   • Every async PC result is tagged with the epoch it was issued under and
//     dropped if stale, so an out-of-order answer / candidate can't throw an
//     unhandled rejection or be applied to the wrong PC.
//   • The reducer is the single owner of the peer session. Overlapping offer
//     triggers (receiver-ready + request-reoffers + Share + retry all call into
//     the same path) bump one epoch and supersede deterministically, instead of
//     two `makeOffer`s racing over a shared `pc` variable.
//   • Incoming ICE that arrives before the answer is applied is buffered and
//     flushed on remote-set (the sender hits the same pre-remote race).

import { tweakSdp } from "./rtc-utils.js";
import {
  bufferOrEmitIce,
  flushIce,
  isCurrentEpoch,
  newPeerSession,
  type Epoch,
  type PeerSession,
} from "./session-protocol.js";

export interface SenderState {
  // The single peer (the receiver), or null when there's nothing to negotiate.
  peer: PeerSession | null;
  nextEpoch: Epoch;
}

export const initialSenderState: SenderState = { peer: null, nextEpoch: 1 };

export type SenderEvent =
  // Something asked us to (re)offer: receiver-ready, request-reoffers, a fresh
  // share, or a failed-connection retry. The adapter only fires this when it's
  // actually appropriate (a stream exists and the receiver is ready).
  | { t: "offer-trigger" }
  // Adapter: createOffer + setLocalDescription for `epoch` resolved.
  | { t: "offer-created"; epoch: Epoch; sdp: string }
  // Wire: the receiver's answer arrived.
  | { t: "answer"; sdp: string }
  // Adapter: setRemoteDescription(answer) for `epoch` resolved.
  | { t: "remote-set"; epoch: Epoch }
  // Wire: a remote ICE candidate arrived from the receiver.
  | { t: "ice"; candidate: RTCIceCandidateInit }
  // Adapter: an async PC op for `epoch` threw.
  | { t: "op-failed"; epoch: Epoch; op: "offer" | "remote" | "ice" }
  // The receiver left, or our share stopped — tear the peer down.
  | { t: "peer-gone" };

export type SenderAction =
  // Close any prior PC and build a fresh one (addTrack the current stream).
  | { t: "create-pc"; epoch: Epoch }
  | { t: "create-offer"; epoch: Epoch }
  // Already tweakSdp'd (H.264 ordering + bandwidth hint) — the adapter just sends it.
  | { t: "send-offer"; epoch: Epoch; sdp: string }
  | { t: "set-remote"; epoch: Epoch; sdp: string }
  | { t: "add-ice"; epoch: Epoch; candidate: RTCIceCandidateInit }
  | { t: "close-pc" };

interface Result {
  state: SenderState;
  actions: SenderAction[];
}

export function senderReduce(state: SenderState, event: SenderEvent): Result {
  switch (event.t) {
    case "offer-trigger": {
      // Always supersede: mint a fresh epoch and rebuild. create-pc closes the old
      // PC, so a still-in-flight prior negotiation is abandoned and its later
      // answer/ICE will be dropped by the epoch guard below.
      const epoch = state.nextEpoch;
      return {
        state: { peer: newPeerSession(epoch), nextEpoch: epoch + 1 },
        actions: [
          { t: "create-pc", epoch },
          { t: "create-offer", epoch },
        ],
      };
    }

    case "offer-created": {
      if (!isCurrentEpoch(state.peer ?? undefined, event.epoch)) return { state, actions: [] };
      // tweakSdp(..., true) sets the offer-side bandwidth hint and H.264 ordering.
      return {
        state,
        actions: [{ t: "send-offer", epoch: event.epoch, sdp: tweakSdp(event.sdp, true) }],
      };
    }

    case "answer": {
      if (!state.peer) return { state, actions: [] };
      return { state, actions: [{ t: "set-remote", epoch: state.peer.epoch, sdp: event.sdp }] };
    }

    case "remote-set": {
      if (!isCurrentEpoch(state.peer ?? undefined, event.epoch)) return { state, actions: [] };
      const { session, emit } = flushIce(state.peer!);
      return {
        state: { ...state, peer: session },
        actions: emit.map((candidate) => ({
          t: "add-ice" as const,
          epoch: event.epoch,
          candidate,
        })),
      };
    }

    case "ice": {
      if (!state.peer) return { state, actions: [] };
      const { session, emit } = bufferOrEmitIce(state.peer, event.candidate);
      return {
        state: { ...state, peer: session },
        actions: emit.map((candidate) => ({
          t: "add-ice" as const,
          epoch: session.epoch,
          candidate,
        })),
      };
    }

    case "op-failed": {
      if (!isCurrentEpoch(state.peer ?? undefined, event.epoch)) return { state, actions: [] };
      // Drop the dead session AND close its PC. Closing here (rather than leaving it
      // for the next create-pc) keeps teardown airtight: if `peer-gone` arrives
      // first — a capture-ended landing before the failed-state retry — it
      // early-returns on the already-null peer, so without this the PC would leak.
      return { state: { ...state, peer: null }, actions: [{ t: "close-pc" }] };
    }

    case "peer-gone": {
      if (!state.peer) return { state, actions: [] };
      return { state: { ...state, peer: null }, actions: [{ t: "close-pc" }] };
    }
  }
}
