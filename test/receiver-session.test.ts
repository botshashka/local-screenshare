import { describe, it, expect } from "vitest";
import {
  receiverReduce,
  initialReceiverState,
  type ReceiverState,
  type ReceiverEvent,
} from "../src/client/receiver-session";
import { harness } from "./reducer-harness";

// The receiver negotiation reducer is pure: feed it events, assert on the returned
// actions + state. No real WebRTC, no timers. These lock in the two bugs the
// imperative onmessage handler shipped: reusing a live PC on a new offer (blank
// video on Re-share), and dropping ICE that arrives before the remote description.

const { drive, actionsFor } = harness(receiverReduce);

// The epoch the reducer assigned to a slot (for feeding adapter-result events).
function epochOf(state: ReceiverState, id: string): number {
  const peer = state.peers[id];
  if (!peer) throw new Error(`no session for ${id}`);
  return peer.epoch;
}

describe("receiverReduce — offer handling", () => {
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

describe("receiverReduce — ICE buffering", () => {
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

describe("receiverReduce — stale epoch guard", () => {
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

// ── Exhaustive property / fuzz coverage ─────────────────────────────────────
// The receiver multiplexes a negotiation per sender slot. Random interleavings
// across both slots must preserve: monotonic global epochs, every action carries
// its slot's CURRENT epoch (no result drives a superseded PC), an offer always
// rebuilds with a fresh epoch, and a stale/peerless event for a slot does nothing.
describe("receiverReduce — invariants under random sequences", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  const IDS = ["device-a", "device-b"];

  function randomEvent(rng: () => number, s: ReceiverState, id: string): ReceiverEvent {
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const epoch = pick([s.peers[id]?.epoch ?? 0, s.nextEpoch, s.nextEpoch - 1, 1, 99]);
    const kind = pick(["offer", "ice", "remote-set", "answer-created", "op-failed"] as const);
    switch (kind) {
      case "offer":
        return { t: "offer", id, sdp: "v=0\r\n" };
      case "ice":
        return { t: "ice", id, candidate: { candidate: "candidate:1" } as RTCIceCandidateInit };
      case "remote-set":
        return { t: "remote-set", id, epoch };
      case "answer-created":
        return { t: "answer-created", id, epoch, sdp: "v=0\r\n" };
      default:
        return { t: "op-failed", id, epoch, op: pick(["remote", "answer", "ice"] as const) };
    }
  }

  it("holds across 4000 random steps over 8 seeds", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rng = lcg(seed * 2654435761);
      let state = initialReceiverState;
      for (let i = 0; i < 500; i++) {
        const id = IDS[Math.floor(rng() * IDS.length)]!;
        const event = randomEvent(rng, state, id);
        const before = structuredClone(state);
        const { state: next, actions } = receiverReduce(state, event);

        // Purity: the reducer never mutates the state it was handed.
        expect(state).toEqual(before);

        // Epochs are monotonic; an offer always rebuilds with a fresh, higher epoch.
        expect(next.nextEpoch).toBeGreaterThanOrEqual(state.nextEpoch);
        if (event.t === "offer") {
          expect(next.nextEpoch).toBe(state.nextEpoch + 1);
          expect(next.peers[id]?.epoch).toBe(state.nextEpoch);
        }

        // Every live (non-placeholder) peer epoch is one already issued.
        for (const peer of Object.values(next.peers)) {
          expect(peer.epoch).toBeLessThan(next.nextEpoch);
        }

        // Every action targets its slot's CURRENT epoch — no result drives a
        // superseded PC for that slot.
        for (const a of actions) {
          expect(a.epoch).toBe(next.peers[a.id]?.epoch);
        }

        // A stale or peerless event for a slot (anything but a fresh offer, or a
        // first ICE that opens a buffering placeholder) emits nothing.
        if (event.t !== "offer" && event.t !== "ice" && !state.peers[id]) {
          expect(actions).toEqual([]);
        }

        state = next;
      }
    }
  });
});
