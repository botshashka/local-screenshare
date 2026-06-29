// Pure receiver-side negotiation reducer. The receiver is always the *answerer*:
// for each sender slot it receives an offer, answers it, and exchanges ICE. This
// module owns those decisions as data so they're unit-testable; the adapter in
// receiver.ts performs the real RTCPeerConnection I/O and feeds results back as
// events.
//
// The invariants it enforces:
//   • An incoming offer ALWAYS rebuilds the PC (new epoch). The sender only ever
//     offers from a brand-new PC, so an offer is always a fresh DTLS/ICE session;
//     reusing a still-`connected` PC leaves ontrack silent → blank video on
//     Re-share / reconnect.
//   • ICE that arrives before setRemoteDescription resolves is buffered and
//     flushed on remote-set, instead of being dropped or throwing.

import { tweakSdp } from "./rtc-utils.js";
import {
  bufferOrEmitIce,
  flushIce,
  isCurrentEpoch,
  type Epoch,
  type PeerSession,
} from "./session-protocol.js";

export interface ReceiverState {
  // One negotiation per sender slot ("device-a" / "device-b").
  peers: Record<string, PeerSession>;
  // Next epoch to hand out — monotonic across the whole receiver.
  nextEpoch: Epoch;
}

export const initialReceiverState: ReceiverState = { peers: {}, nextEpoch: 1 };

export type ReceiverEvent =
  // Wire: an offer arrived from sender `id`.
  | { t: "offer"; id: string; sdp: string }
  // Wire: a remote ICE candidate arrived from sender `id`.
  | { t: "ice"; id: string; candidate: RTCIceCandidateInit }
  // Adapter: setRemoteDescription(offer) for (id, epoch) resolved.
  | { t: "remote-set"; id: string; epoch: Epoch }
  // Adapter: createAnswer + setLocalDescription for (id, epoch) resolved.
  | { t: "answer-created"; id: string; epoch: Epoch; sdp: string }
  // Adapter: an async PC op for (id, epoch) threw.
  | { t: "op-failed"; id: string; epoch: Epoch; op: "remote" | "answer" | "ice" };

export type ReceiverAction =
  // Close any prior PC for this slot and build a fresh one (recvonly transceivers).
  | { t: "create-pc"; id: string; epoch: Epoch }
  | { t: "set-remote"; id: string; epoch: Epoch; sdp: string }
  | { t: "create-answer"; id: string; epoch: Epoch }
  // Already tweakSdp'd — the adapter just addresses and sends it.
  | { t: "send-answer"; id: string; epoch: Epoch; sdp: string }
  | { t: "add-ice"; id: string; epoch: Epoch; candidate: RTCIceCandidateInit };

interface Result {
  state: ReceiverState;
  actions: ReceiverAction[];
}

function withPeer(state: ReceiverState, id: string, session: PeerSession): ReceiverState {
  return { ...state, peers: { ...state.peers, [id]: session } };
}

function withoutPeer(state: ReceiverState, id: string): ReceiverState {
  const peers: Record<string, PeerSession> = {};
  for (const [key, value] of Object.entries(state.peers)) {
    if (key !== id) peers[key] = value;
  }
  return { ...state, peers };
}

export function receiverReduce(state: ReceiverState, event: ReceiverEvent): Result {
  switch (event.t) {
    case "offer": {
      // Always a new session. Mint a fresh epoch and rebuild; carry over any ICE
      // that arrived before the offer (the rare pre-offer candidate) so it flushes
      // once this offer's remote description is set.
      const epoch = state.nextEpoch;
      const prior = state.peers[event.id];
      const session: PeerSession = {
        epoch,
        remoteSet: false,
        pendingIce: prior?.pendingIce ?? [],
      };
      return {
        state: { ...withPeer(state, event.id, session), nextEpoch: epoch + 1 },
        actions: [
          { t: "create-pc", id: event.id, epoch },
          { t: "set-remote", id: event.id, epoch, sdp: event.sdp },
        ],
      };
    }

    case "ice": {
      const existing = state.peers[event.id];
      if (!existing) {
        // No offer yet — buffer in a placeholder (epoch 0, no PC). The next offer
        // inherits this pendingIce and flushes it after its remote description.
        const session: PeerSession = { epoch: 0, remoteSet: false, pendingIce: [event.candidate] };
        return { state: withPeer(state, event.id, session), actions: [] };
      }
      const { session, emit } = bufferOrEmitIce(existing, event.candidate);
      return {
        state: withPeer(state, event.id, session),
        actions: emit.map((candidate) => ({
          t: "add-ice" as const,
          id: event.id,
          epoch: session.epoch,
          candidate,
        })),
      };
    }

    case "remote-set": {
      const existing = state.peers[event.id];
      if (!isCurrentEpoch(existing, event.epoch)) return { state, actions: [] };
      const { session, emit } = flushIce(existing!);
      return {
        state: withPeer(state, event.id, session),
        actions: [
          { t: "create-answer", id: event.id, epoch: event.epoch },
          ...emit.map((candidate) => ({
            t: "add-ice" as const,
            id: event.id,
            epoch: event.epoch,
            candidate,
          })),
        ],
      };
    }

    case "answer-created": {
      const existing = state.peers[event.id];
      if (!isCurrentEpoch(existing, event.epoch)) return { state, actions: [] };
      // tweakSdp here keeps the on-wire answer (VP9 ordering, opus fmtp) under test.
      return {
        state,
        actions: [{ t: "send-answer", id: event.id, epoch: event.epoch, sdp: tweakSdp(event.sdp) }],
      };
    }

    case "op-failed": {
      const existing = state.peers[event.id];
      if (!isCurrentEpoch(existing, event.epoch)) return { state, actions: [] };
      // Drop the dead session so the next offer (or a liveness re-offer) rebuilds
      // from scratch and no buffered ICE flushes onto a failed PC.
      return { state: withoutPeer(state, event.id), actions: [] };
    }
  }
}
