import { describe, it, expect } from "vitest";
import {
  senderReduce,
  initialSenderState,
  type SenderState,
  type SenderEvent,
  type SenderAction,
} from "../src/client/sender-session";

// The sender negotiation reducer is pure. These lock in the duplicate-offer race
// (#3) and the stale-result guard (#2) that the imperative makeOffer/onmessage
// could not enforce, plus incoming-ICE buffering (#4).

function drive(state: SenderState, ...events: SenderEvent[]): SenderState {
  return events.reduce((s, e) => senderReduce(s, e).state, state);
}

function actionsFor(state: SenderState, event: SenderEvent): SenderAction[] {
  return senderReduce(state, event).actions;
}

function epochOf(state: SenderState): number {
  if (!state.peer) throw new Error("no peer session");
  return state.peer.epoch;
}

describe("senderReduce — offer triggers (bug #3)", () => {
  it("builds a fresh PC and offer on a trigger", () => {
    const { state, actions } = senderReduce(initialSenderState, { t: "offer-trigger" });
    const epoch = epochOf(state);
    expect(actions).toEqual([
      { t: "create-pc", epoch },
      { t: "create-offer", epoch },
    ]);
  });

  it("a second trigger supersedes the first with a higher epoch", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const first = epochOf(state);
    state = drive(state, { t: "offer-trigger" });
    expect(epochOf(state)).toBeGreaterThan(first);
  });

  it("drops an offer-created tagged with a superseded epoch (no stale offer goes out)", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const stale = epochOf(state);
    state = drive(state, { t: "offer-trigger" }); // supersede
    expect(actionsFor(state, { t: "offer-created", epoch: stale, sdp: "x" })).toEqual([]);
  });

  it("sends the current offer with VP9 ordering + bandwidth hint applied", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const epoch = epochOf(state);
    const rawSdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 98\r\na=rtpmap:98 VP9/90000\r\n";
    const { actions } = senderReduce(state, { t: "offer-created", epoch, sdp: rawSdp });
    const send = actions.find((a) => a.t === "send-offer");
    expect(send && send.t === "send-offer" && send.sdp).toContain(
      "m=video 9 UDP/TLS/RTP/SAVPF 98 96",
    );
    expect(send && send.t === "send-offer" && send.sdp).toContain("b=AS:6000"); // offer-side hint
  });
});

describe("senderReduce — answer + ICE (bugs #2/#4)", () => {
  it("applies an answer to the current epoch's PC", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const epoch = epochOf(state);
    const { actions } = senderReduce(state, { t: "answer", sdp: "ANSWER" });
    expect(actions).toEqual([{ t: "set-remote", epoch, sdp: "ANSWER" }]);
  });

  it("ignores an answer when there's no active offer", () => {
    expect(actionsFor(initialSenderState, { t: "answer", sdp: "ANSWER" })).toEqual([]);
  });

  it("buffers incoming ICE until the answer is set, then flushes it", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const epoch = epochOf(state);
    const cand = { candidate: "candidate:1" } as RTCIceCandidateInit;

    const buffered = senderReduce(state, { t: "ice", candidate: cand });
    expect(buffered.actions).toEqual([]); // remote not set yet
    state = buffered.state;

    const flushed = senderReduce(state, { t: "remote-set", epoch });
    expect(flushed.actions).toEqual([{ t: "add-ice", epoch, candidate: cand }]);
  });

  it("drops the session on a current-epoch op-failed; a new trigger rebuilds", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const epoch = epochOf(state);
    state = senderReduce(state, { t: "op-failed", epoch, op: "remote" }).state;
    expect(state.peer).toBeNull();
    expect(actionsFor(state, { t: "offer-trigger" }).some((a) => a.t === "create-pc")).toBe(true);
  });

  it("tears down the peer on peer-gone", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const { state: next, actions } = senderReduce(state, { t: "peer-gone" });
    expect(next.peer).toBeNull();
    expect(actions).toEqual([{ t: "close-pc" }]);
  });
});
