import { describe, it, expect } from "vitest";
import {
  receiverReduce,
  initialReceiverState,
  type ReceiverState,
  type ReceiverEvent,
  type ReceiverAction,
} from "../src/client/receiver-session";

// The receiver negotiation reducer is pure: feed it events, assert on the returned
// actions + state. No real WebRTC, no timers. These lock in the two bugs the
// imperative onmessage handler shipped: reusing a live PC on a new offer (blank
// video on Re-share), and dropping ICE that arrives before the remote description.

// Drive a sequence of events, returning the final state.
function drive(state: ReceiverState, ...events: ReceiverEvent[]): ReceiverState {
  return events.reduce((s, e) => receiverReduce(s, e).state, state);
}

// The epoch the reducer assigned to a slot (for feeding adapter-result events).
function epochOf(state: ReceiverState, id: string): number {
  const peer = state.peers[id];
  if (!peer) throw new Error(`no session for ${id}`);
  return peer.epoch;
}

function actionsFor(state: ReceiverState, event: ReceiverEvent): ReceiverAction[] {
  return receiverReduce(state, event).actions;
}

describe("receiverReduce — offer handling (bug #1)", () => {
  it("builds a fresh PC on the first offer and sets the remote description", () => {
    const { state, actions } = receiverReduce(initialReceiverState, {
      t: "offer",
      id: "device-a",
      sdp: "OFFER",
    });
    const epoch = epochOf(state, "device-a");
    expect(actions).toEqual([
      { t: "create-pc", id: "device-a", epoch },
      { t: "set-remote", id: "device-a", epoch, sdp: "OFFER" },
    ]);
  });

  it("ALWAYS rebuilds the PC on a re-offer, even when the slot is already live", () => {
    // First offer → answered → remote set (the slot is now "connected" in the
    // adapter). The old code would reuse this PC for the next offer and go blank.
    let state = drive(initialReceiverState, { t: "offer", id: "device-a", sdp: "OFFER1" });
    const e1 = epochOf(state, "device-a");
    state = drive(state, { t: "remote-set", id: "device-a", epoch: e1 });

    // A Re-share / reconnect sends a brand-new offer for the same slot.
    const { state: next, actions } = receiverReduce(state, {
      t: "offer",
      id: "device-a",
      sdp: "OFFER2",
    });
    const e2 = epochOf(next, "device-a");
    expect(e2).toBeGreaterThan(e1); // a new generation, not a reuse
    expect(actions).toContainEqual({ t: "create-pc", id: "device-a", epoch: e2 });
    expect(actions).toContainEqual({ t: "set-remote", id: "device-a", epoch: e2, sdp: "OFFER2" });
  });

  it("keeps the two sender slots independent", () => {
    let state = drive(initialReceiverState, { t: "offer", id: "device-a", sdp: "A" });
    state = drive(state, { t: "offer", id: "device-b", sdp: "B" });
    expect(epochOf(state, "device-a")).not.toEqual(epochOf(state, "device-b"));
  });
});

describe("receiverReduce — ICE buffering (bug #4)", () => {
  it("buffers a candidate that arrives before remote-set, then flushes it", () => {
    let state = drive(initialReceiverState, { t: "offer", id: "device-a", sdp: "OFFER" });
    const epoch = epochOf(state, "device-a");

    // Candidate arrives while setRemoteDescription is still in flight → buffered.
    const cand = { candidate: "candidate:1", sdpMid: "0" } as RTCIceCandidateInit;
    const buffered = receiverReduce(state, { t: "ice", id: "device-a", candidate: cand });
    expect(buffered.actions).toEqual([]); // not applied yet
    state = buffered.state;

    // Remote description lands → the buffered candidate is emitted (after the answer).
    const flushed = receiverReduce(state, { t: "remote-set", id: "device-a", epoch });
    expect(flushed.actions).toContainEqual({ t: "add-ice", id: "device-a", epoch, candidate: cand });
    expect(flushed.actions[0]).toEqual({ t: "create-answer", id: "device-a", epoch });
  });

  it("applies a candidate immediately once the remote description is set", () => {
    let state = drive(initialReceiverState, { t: "offer", id: "device-a", sdp: "OFFER" });
    const epoch = epochOf(state, "device-a");
    state = drive(state, { t: "remote-set", id: "device-a", epoch });

    const cand = { candidate: "candidate:2" } as RTCIceCandidateInit;
    const { actions } = receiverReduce(state, { t: "ice", id: "device-a", candidate: cand });
    expect(actions).toEqual([{ t: "add-ice", id: "device-a", epoch, candidate: cand }]);
  });

  it("buffers a candidate that arrives before the offer, flushing it under the offer's epoch", () => {
    const cand = { candidate: "candidate:early" } as RTCIceCandidateInit;
    let state = drive(initialReceiverState, { t: "ice", id: "device-a", candidate: cand });
    expect(actionsFor(state, { t: "ice", id: "device-a", candidate: cand })).toEqual([]);

    state = drive(state, { t: "offer", id: "device-a", sdp: "OFFER" });
    const epoch = epochOf(state, "device-a");
    const { actions } = receiverReduce(state, { t: "remote-set", id: "device-a", epoch });
    expect(actions).toContainEqual({ t: "add-ice", id: "device-a", epoch, candidate: cand });
  });
});

describe("receiverReduce — stale epoch guard (bug #2/#3)", () => {
  it("ignores adapter results tagged with a superseded epoch", () => {
    let state = drive(initialReceiverState, { t: "offer", id: "device-a", sdp: "OFFER1" });
    const stale = epochOf(state, "device-a");
    // A second offer supersedes the first before its remote-set comes back.
    state = drive(state, { t: "offer", id: "device-a", sdp: "OFFER2" });
    const current = epochOf(state, "device-a");
    expect(current).toBeGreaterThan(stale);

    // The stale remote-set / answer must be dropped — no actions.
    expect(actionsFor(state, { t: "remote-set", id: "device-a", epoch: stale })).toEqual([]);
    expect(actionsFor(state, { t: "answer-created", id: "device-a", epoch: stale, sdp: "x" })).toEqual(
      [],
    );
  });

  it("emits a tweakSdp'd answer for the current epoch", () => {
    let state = drive(initialReceiverState, { t: "offer", id: "device-a", sdp: "OFFER" });
    const epoch = epochOf(state, "device-a");
    state = drive(state, { t: "remote-set", id: "device-a", epoch });

    // An answer SDP advertising VP9 should come back with VP9 promoted on m=video.
    const rawSdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 98\r\na=rtpmap:98 VP9/90000\r\n";
    const { actions } = receiverReduce(state, {
      t: "answer-created",
      id: "device-a",
      epoch,
      sdp: rawSdp,
    });
    const send = actions.find((a) => a.t === "send-answer");
    expect(send).toBeDefined();
    expect(send && send.t === "send-answer" && send.sdp).toContain("m=video 9 UDP/TLS/RTP/SAVPF 98 96");
  });

  it("drops the session on a current-epoch op-failed so the next offer rebuilds clean", () => {
    let state = drive(initialReceiverState, { t: "offer", id: "device-a", sdp: "OFFER" });
    const epoch = epochOf(state, "device-a");
    state = receiverReduce(state, { t: "op-failed", id: "device-a", epoch, op: "remote" }).state;
    expect(state.peers["device-a"]).toBeUndefined();

    // A fresh offer still works (new epoch, clean rebuild).
    const { actions } = receiverReduce(state, { t: "offer", id: "device-a", sdp: "OFFER2" });
    expect(actions.some((a) => a.t === "create-pc")).toBe(true);
  });
});
