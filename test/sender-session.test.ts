import { describe, it, expect } from "vitest";
import {
  senderReduce,
  initialSenderState,
  type SenderState,
  type SenderEvent,
} from "../src/client/sender-session";
import { harness } from "./reducer-harness";

// The sender negotiation reducer is pure. These lock in the duplicate-offer race
// and the stale-result guard that the imperative makeOffer/onmessage could not
// enforce, plus incoming-ICE buffering.

const { drive, actionsFor } = harness(senderReduce);

function epochOf(state: SenderState): number {
  if (!state.peer) throw new Error("no peer session");
  return state.peer.epoch;
}

describe("senderReduce — offer triggers", () => {
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

  it("sends the current offer with H.264 ordering + bandwidth hint applied", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const epoch = epochOf(state);
    const rawSdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 98 96\r\na=rtpmap:96 H264/90000\r\n";
    const { actions } = senderReduce(state, { t: "offer-created", epoch, sdp: rawSdp });
    const send = actions.find((a) => a.t === "send-offer");
    expect(send && send.t === "send-offer" && send.sdp).toContain(
      "m=video 9 UDP/TLS/RTP/SAVPF 96 98",
    );
    expect(send && send.t === "send-offer" && send.sdp).toContain("b=AS:6000"); // offer-side hint
  });
});

describe("senderReduce — answer + ICE", () => {
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

  it("drops the session AND closes the PC on a current-epoch op-failed; a new trigger rebuilds", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const epoch = epochOf(state);
    const failed = senderReduce(state, { t: "op-failed", epoch, op: "remote" });
    // close-pc keeps teardown airtight: a capture-ended (peer-gone) arriving before
    // the failed-state retry would otherwise leave the dead PC un-closed.
    expect(failed.actions).toEqual([{ t: "close-pc" }]);
    state = failed.state;
    expect(state.peer).toBeNull();
    expect(actionsFor(state, { t: "offer-trigger" }).some((a) => a.t === "create-pc")).toBe(true);
  });

  it("a stale op-failed is ignored (no close-pc for a superseded epoch)", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const stale = epochOf(state);
    state = drive(state, { t: "offer-trigger" }); // supersede
    expect(actionsFor(state, { t: "op-failed", epoch: stale, op: "remote" })).toEqual([]);
  });

  it("tears down the peer on peer-gone", () => {
    let state = drive(initialSenderState, { t: "offer-trigger" });
    const { state: next, actions } = senderReduce(state, { t: "peer-gone" });
    expect(next.peer).toBeNull();
    expect(actions).toEqual([{ t: "close-pc" }]);
  });
});

// ── Exhaustive property / fuzz coverage ─────────────────────────────────────
// Random event sequences must never break the epoch-ownership invariants the
// adapter relies on: epochs are monotonic, every epoch-bearing action targets the
// CURRENT peer epoch (never a stale PC), and nothing but a fresh offer-trigger does
// anything once the peer is gone. A seeded LCG keeps any failure reproducible.
describe("senderReduce — invariants under random sequences", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  // Bias epochs toward the live one so both currency and staleness are exercised.
  function randomEvent(rng: () => number, s: SenderState): SenderEvent {
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const epoch = pick([s.peer?.epoch ?? 0, s.nextEpoch, s.nextEpoch - 1, 1, 99]);
    const kind = pick([
      "offer-trigger",
      "offer-created",
      "answer",
      "remote-set",
      "ice",
      "op-failed",
      "peer-gone",
    ] as const);
    switch (kind) {
      case "offer-created":
        return { t: "offer-created", epoch, sdp: "v=0\r\n" };
      case "remote-set":
        return { t: "remote-set", epoch };
      case "op-failed":
        return { t: "op-failed", epoch, op: pick(["offer", "remote", "ice"] as const) };
      case "answer":
        return { t: "answer", sdp: "ANSWER" };
      case "ice":
        return { t: "ice", candidate: { candidate: "candidate:1" } as RTCIceCandidateInit };
      default:
        return { t: kind };
    }
  }

  // Actions that name an epoch — each must match the resulting live peer's epoch.
  const EPOCH_ACTIONS = ["create-pc", "create-offer", "send-offer", "set-remote", "add-ice"];

  it("holds across 4000 random steps over 8 seeds", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rng = lcg(seed * 2654435761);
      let state = initialSenderState;
      for (let i = 0; i < 500; i++) {
        const event = randomEvent(rng, state);
        const before = structuredClone(state);
        const { state: next, actions } = senderReduce(state, event);

        // Purity: the reducer never mutates the state it was handed.
        expect(state).toEqual(before);

        // Epochs are monotonic; a fresh trigger supersedes by exactly one.
        expect(next.nextEpoch).toBeGreaterThanOrEqual(state.nextEpoch);
        if (event.t === "offer-trigger") {
          expect(next.nextEpoch).toBe(state.nextEpoch + 1);
          expect(next.peer?.epoch).toBe(state.nextEpoch);
        }
        // A live peer's epoch is always one already issued.
        if (next.peer) expect(next.peer.epoch).toBeLessThan(next.nextEpoch);

        // Every epoch-bearing action targets the current peer epoch — no action can
        // drive a superseded PC.
        for (const a of actions) {
          if (EPOCH_ACTIONS.includes(a.t)) {
            expect((a as { epoch: number }).epoch).toBe(next.peer?.epoch);
          }
          // close-pc is only ever a teardown, and leaves no peer behind.
          if (a.t === "close-pc") expect(next.peer).toBeNull();
        }

        // Once the peer is gone, only a fresh offer-trigger may act.
        if (state.peer === null && event.t !== "offer-trigger") {
          expect(actions).toEqual([]);
        }

        state = next;
      }
    }
  });
});
