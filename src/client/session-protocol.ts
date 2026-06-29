// Shared, pure building blocks for the client-side signaling reducers (sender and
// receiver). Nothing here touches a real WebSocket, RTCPeerConnection, timer, or
// the DOM — the reducers decide, the adapters act. Keeping the negotiation logic
// here (and unit-testing it) is what turns the formerly-untestable onmessage
// handlers into something we can prove correct.

// A monotonically increasing per-peer session id. Every RTCPeerConnection the app
// builds is a *fresh* one (the sender always closes+recreates before offering, so
// every offer is a new DTLS/ICE session — see sender makeOffer), so async results
// from the WebRTC API can race a newer session. The epoch is a LOCAL guard: every
// async PC op is issued under the epoch current when it started, and the adapter
// feeds the result back tagged with that epoch; the reducer drops any result whose
// epoch is no longer current. The wire protocol never carries it (the hub is
// frozen) — it exists only inside one client.
export type Epoch = number;

// One peer's negotiation state. The sender has exactly one (the receiver); the
// receiver keeps one per sender slot. `remoteSet` gates ICE: a candidate added
// before setRemoteDescription has resolved throws, so candidates are buffered in
// `pendingIce` until the remote description lands, then flushed.
export interface PeerSession {
  epoch: Epoch;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
}

export function newPeerSession(epoch: Epoch): PeerSession {
  return { epoch, remoteSet: false, pendingIce: [] };
}

// True iff `s` exists and is still the current generation for its peer — the
// stale-op guard every async result is filtered through.
export function isCurrentEpoch(s: PeerSession | undefined, epoch: Epoch): boolean {
  return s !== undefined && s.epoch === epoch;
}

// Add an incoming remote ICE candidate. If the remote description is already set,
// it's safe to apply now (`emit` carries it); otherwise it's held in the session
// until flushIce runs. Returns the next session and any candidates to apply now.
export function bufferOrEmitIce(
  s: PeerSession,
  candidate: RTCIceCandidateInit,
): { session: PeerSession; emit: RTCIceCandidateInit[] } {
  if (s.remoteSet) return { session: s, emit: [candidate] };
  return { session: { ...s, pendingIce: [...s.pendingIce, candidate] }, emit: [] };
}

// Mark the remote description set and drain every buffered candidate. Returns the
// next session (remoteSet, empty buffer) and the candidates to apply, in arrival
// order. Idempotent in effect: a second call simply emits nothing.
export function flushIce(s: PeerSession): { session: PeerSession; emit: RTCIceCandidateInit[] } {
  return { session: { ...s, remoteSet: true, pendingIce: [] }, emit: s.pendingIce };
}
