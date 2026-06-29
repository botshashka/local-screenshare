import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  receiverControllerReduce,
  wantRoomCard,
  roomCardEffect,
  initialReceiverControllerState,
  type ReceiverControllerState,
  type ReceiverControllerEvent,
} from "../src/client/receiver-controller";
import { harness } from "./reducer-harness";

// The receiver per-slot media controller is pure. The headline property — the
// srcObject invariant ("nulled only on peer-disconnected, reset only on
// offer-arrived") — is encoded here as a tested rule rather than a comment a
// future edit could quietly break. No fake RTCPeerConnection can catch a
// regression in the browser semantic itself, but these prove the *rule*.

const A = "device-a";

const { drive, actionsFor } = harness(receiverControllerReduce);

// Drive a slot to revealed-and-connected at generation `gen`.
function live(id = A, gen = 1): ReceiverControllerState {
  return drive(
    initialReceiverControllerState,
    { t: "offer-arrived", id, gen },
    { t: "connection-changed", id, gen, state: "connected" },
    { t: "frame-decoded", id, gen },
  );
}

describe("receiverControllerReduce — per-transition", () => {
  it("offer-arrived resets the source, bumps gen, keeps the reveal latch", () => {
    const s = live(A, 1); // revealed
    const { state, actions } = receiverControllerReduce(s, { t: "offer-arrived", id: A, gen: 2 });
    expect(actions).toEqual([{ t: "reset-srcobject", id: A }]);
    expect(state.slots[A]).toMatchObject({ pcGen: 2, conn: "connecting", revealed: true });
  });

  it("offer-arrived cancels a pending retry on rebuild", () => {
    const s = drive(
      initialReceiverControllerState,
      { t: "offer-arrived", id: A, gen: 1 },
      { t: "connection-changed", id: A, gen: 1, state: "connected" },
      { t: "frame-decoded", id: A, gen: 1 },
      { t: "liveness-lost", id: A, gen: 1 }, // schedules a retry
    );
    expect(s.slots[A]?.retryPending).toBe(true);
    const { state, actions } = receiverControllerReduce(s, { t: "offer-arrived", id: A, gen: 2 });
    expect(actions).toEqual([{ t: "reset-srcobject", id: A }, { t: "cancel-retry", id: A }]);
    expect(state.slots[A]?.retryPending).toBe(false);
  });

  it("connection-changed{connected} tunes receivers and arms the reveal fallback", () => {
    const s = drive(initialReceiverControllerState, { t: "offer-arrived", id: A, gen: 1 });
    const { state, actions } = receiverControllerReduce(s, {
      t: "connection-changed",
      id: A,
      gen: 1,
      state: "connected",
    });
    expect(actions).toEqual([
      { t: "tune-receivers", id: A },
      { t: "schedule-reveal-fallback", id: A, gen: 1 },
    ]);
    expect(state.slots[A]?.conn).toBe("connected");
  });

  it("connection-changed{disconnected|failed} keeps the last frame (no media actions)", () => {
    const s = live(A, 1);
    expect(actionsFor(s, { t: "connection-changed", id: A, gen: 1, state: "disconnected" })).toEqual([]);
    expect(actionsFor(s, { t: "connection-changed", id: A, gen: 1, state: "failed" })).toEqual([]);
    // and the reveal latch is untouched
    const after = drive(s, { t: "connection-changed", id: A, gen: 1, state: "disconnected" });
    expect(after.slots[A]?.revealed).toBe(true);
  });

  it("reveals on the first decoded frame, idempotently", () => {
    const s = drive(
      initialReceiverControllerState,
      { t: "offer-arrived", id: A, gen: 1 },
      { t: "connection-changed", id: A, gen: 1, state: "connected" },
    );
    const first = receiverControllerReduce(s, { t: "frame-decoded", id: A, gen: 1 });
    expect(first.actions).toEqual([{ t: "reveal-slot", id: A }]);
    expect(first.state.slots[A]?.revealed).toBe(true);
    // a second frame is a no-op
    expect(actionsFor(first.state, { t: "frame-decoded", id: A, gen: 1 })).toEqual([]);
  });

  it("ignores a stale frame from a superseded generation (no reveal mid-rebuild)", () => {
    // connected at gen 2, but a queued rVFC from gen 1 fires
    const s = drive(
      initialReceiverControllerState,
      { t: "offer-arrived", id: A, gen: 1 },
      { t: "offer-arrived", id: A, gen: 2 },
    );
    expect(actionsFor(s, { t: "frame-decoded", id: A, gen: 1 })).toEqual([]);
    expect(s.slots[A]?.revealed).toBe(false);
  });

  it("reveal fallback only fires when current-gen AND connected", () => {
    const connecting = drive(initialReceiverControllerState, { t: "offer-arrived", id: A, gen: 1 });
    expect(actionsFor(connecting, { t: "reveal-fallback-fired", id: A, gen: 1 })).toEqual([]); // not connected
    const connected = drive(connecting, { t: "connection-changed", id: A, gen: 1, state: "connected" });
    expect(actionsFor(connected, { t: "reveal-fallback-fired", id: A, gen: 1 })).toEqual([
      { t: "reveal-slot", id: A },
    ]);
    expect(actionsFor(connected, { t: "reveal-fallback-fired", id: A, gen: 99 })).toEqual([]); // stale
  });

  it("liveness-lost un-reveals, marks disconnected, and schedules one retry", () => {
    const s = live(A, 1);
    const first = receiverControllerReduce(s, { t: "liveness-lost", id: A, gen: 1 });
    expect(first.actions).toEqual([
      { t: "mark-disconnected", id: A },
      { t: "schedule-retry", id: A, gen: 1 },
    ]);
    expect(first.state.slots[A]).toMatchObject({ revealed: false, retryPending: true });
    // a second loss does not schedule a duplicate retry
    expect(actionsFor(first.state, { t: "liveness-lost", id: A, gen: 1 })).toEqual([
      { t: "mark-disconnected", id: A },
    ]);
  });

  it("retry-fired requests a re-offer; a stale-gen retry is ignored", () => {
    const s = drive(live(A, 1), { t: "liveness-lost", id: A, gen: 1 });
    expect(actionsFor(s, { t: "retry-fired", id: A, gen: 1 })).toEqual([{ t: "request-reoffer", id: A }]);
    // a retry timer left over from an older gen must not fire or clear the new one
    expect(actionsFor(s, { t: "retry-fired", id: A, gen: 99 })).toEqual([]);
    expect(drive(s, { t: "retry-fired", id: A, gen: 99 }).slots[A]?.retryPending).toBe(true);
  });

  it("peer-disconnected nulls the source once and resets the slot to a sentinel", () => {
    const s = live(A, 1);
    const { state, actions } = receiverControllerReduce(s, { t: "peer-disconnected", id: A });
    expect(actions).toEqual([
      { t: "null-srcobject", id: A },
      { t: "mark-disconnected", id: A },
      { t: "stop-liveness", id: A },
    ]);
    expect(state.slots[A]).toMatchObject({ pcGen: 0, revealed: false, retryPending: false });
    // any later stale gen-tagged event is now ignored
    expect(actionsFor(state, { t: "frame-decoded", id: A, gen: 1 })).toEqual([]);
  });

  it("connection-changed{connected} cancels a pending retry on recovery", () => {
    const lost = drive(live(A, 1), { t: "liveness-lost", id: A, gen: 1 }); // retryPending
    const { state, actions } = receiverControllerReduce(lost, {
      t: "connection-changed",
      id: A,
      gen: 1,
      state: "connected",
    });
    expect(actions).toEqual([
      { t: "cancel-retry", id: A },
      { t: "tune-receivers", id: A },
      { t: "schedule-reveal-fallback", id: A, gen: 1 },
    ]);
    expect(state.slots[A]?.retryPending).toBe(false);
  });

  it("peer-disconnected cancels a pending retry", () => {
    const lost = drive(live(A, 1), { t: "liveness-lost", id: A, gen: 1 });
    expect(actionsFor(lost, { t: "peer-disconnected", id: A })).toEqual([
      { t: "null-srcobject", id: A },
      { t: "mark-disconnected", id: A },
      { t: "stop-liveness", id: A },
      { t: "cancel-retry", id: A },
    ]);
  });

  it("peer-disconnected on a never-seen slot is still a clean teardown", () => {
    const { actions } = receiverControllerReduce(initialReceiverControllerState, {
      t: "peer-disconnected",
      id: A,
    });
    expect(actions).toEqual([
      { t: "null-srcobject", id: A },
      { t: "mark-disconnected", id: A },
      { t: "stop-liveness", id: A },
    ]);
  });
});

describe("receiverControllerReduce — superseded-PC guard", () => {
  it("drops connection-changed from an old generation", () => {
    const s = drive(
      initialReceiverControllerState,
      { t: "offer-arrived", id: A, gen: 1 },
      { t: "offer-arrived", id: A, gen: 2 },
    );
    expect(actionsFor(s, { t: "connection-changed", id: A, gen: 1, state: "connected" })).toEqual([]);
    expect(s.slots[A]?.conn).toBe("connecting"); // unchanged by the stale event
  });

  it("drops liveness-lost from an old generation", () => {
    const s = drive(live(A, 1), { t: "offer-arrived", id: A, gen: 2 });
    expect(actionsFor(s, { t: "liveness-lost", id: A, gen: 1 })).toEqual([]);
  });
});

describe("wantRoomCard — derived view", () => {
  it("is false with no hub regardless of slots", () => {
    expect(wantRoomCard(initialReceiverControllerState, false)).toBe(false);
    expect(wantRoomCard(live(A, 1), false)).toBe(false);
  });

  it("shows when nothing is revealed, hides when any slot is revealed", () => {
    expect(wantRoomCard(initialReceiverControllerState, true)).toBe(true);
    const connecting = drive(initialReceiverControllerState, { t: "offer-arrived", id: A, gen: 1 });
    expect(wantRoomCard(connecting, true)).toBe(true); // not revealed yet
    expect(wantRoomCard(live(A, 1), true)).toBe(false); // revealed → card hidden
  });

  it("stays hidden across a rebuild (the no-flash guarantee)", () => {
    const rebuilding = drive(live(A, 1), { t: "offer-arrived", id: A, gen: 2 });
    // mid-rebuild: connecting again, but the reveal latch persists, so no card
    expect(rebuilding.slots[A]?.conn).toBe("connecting");
    expect(wantRoomCard(rebuilding, true)).toBe(false);
  });

  it("hides while either of two slots is revealed", () => {
    const aLive = live("device-a", 1);
    const bLive = drive(aLive, { t: "offer-arrived", id: "device-b", gen: 2 }); // b connecting
    expect(wantRoomCard(bLive, true)).toBe(false); // a still revealed
  });
});

describe("roomCardEffect — edge-trigger decision (H5 starvation guard)", () => {
  it("no-ops when the desired state is unchanged (never re-arms the grace timer)", () => {
    expect(roomCardEffect(true, true)).toBe("none");
    expect(roomCardEffect(false, false)).toBe("none");
  });

  it("hides immediately on true→false, defers showing on false→true", () => {
    expect(roomCardEffect(true, false)).toBe("hide-now");
    expect(roomCardEffect(false, true)).toBe("show-deferred");
  });

  it("acts on the first call (prev null)", () => {
    expect(roomCardEffect(null, true)).toBe("show-deferred");
    expect(roomCardEffect(null, false)).toBe("hide-now");
  });
});

// ── Invariant encoding: provenance + fuzz ───────────────────────────────────
// The srcObject invariant and the action-provenance rules, proven over a large
// set of reachable states (collected by random walk) and under random sequences.
describe("receiverControllerReduce — invariants", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  function randomEvent(rng: () => number, id: string, slotGen: number): ReceiverControllerEvent {
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    // Bias gens toward the live one so currency AND staleness are exercised.
    const gen = pick([slotGen, slotGen, slotGen + 1, 99, 1, 2]);
    const kind = pick([
      "offer-arrived",
      "connection-changed",
      "frame-decoded",
      "reveal-fallback-fired",
      "liveness-lost",
      "retry-fired",
      "peer-disconnected",
    ] as const);
    switch (kind) {
      case "connection-changed":
        return {
          t: "connection-changed",
          id,
          gen,
          state: pick(["new", "connecting", "connected", "disconnected", "failed"] as const),
        };
      case "peer-disconnected":
        return { t: "peer-disconnected", id };
      case "offer-arrived":
        // a real rebuild always uses a fresh, higher gen
        return { t: "offer-arrived", id, gen: slotGen + 1 };
      default:
        return { t: kind, id, gen };
    }
  }

  it("action provenance holds over random sequences (2 slots, 8 seeds × 600 steps)", () => {
    const ids = ["device-a", "device-b"];
    for (let seed = 1; seed <= 8; seed++) {
      const rng = lcg(seed * 2654435761);
      let state = initialReceiverControllerState;
      const nulls: Record<string, number> = { "device-a": 0, "device-b": 0 };
      const peerGone: Record<string, number> = { "device-a": 0, "device-b": 0 };
      const resets: Record<string, number> = { "device-a": 0, "device-b": 0 };
      const offers: Record<string, number> = { "device-a": 0, "device-b": 0 };

      for (let i = 0; i < 600; i++) {
        const id = ids[Math.floor(rng() * ids.length)]!;
        const before = state.slots[id]?.pcGen ?? 0;
        const event = randomEvent(rng, id, before);
        const { state: next, actions } = receiverControllerReduce(state, event);

        if (event.t === "peer-disconnected") peerGone[id]!++;
        if (event.t === "offer-arrived") offers[event.id]!++;

        for (const a of actions) {
          // Biconditional provenance for the two srcObject writes.
          if (a.t === "null-srcobject") {
            expect(event.t).toBe("peer-disconnected");
            nulls[a.id]!++;
          }
          if (a.t === "reset-srcobject") {
            expect(event.t).toBe("offer-arrived");
            resets[a.id]!++;
          }
          // mark-disconnected only from a real loss or a true departure.
          if (a.t === "mark-disconnected") {
            expect(["liveness-lost", "peer-disconnected"]).toContain(event.t);
          }
          // reveal only from a frame/fallback of the CURRENT generation.
          if (a.t === "reveal-slot") {
            expect(["frame-decoded", "reveal-fallback-fired"]).toContain(event.t);
            expect((event as { gen: number }).gen).toBe(before);
          }
        }
        // The other direction: peer-disconnected ALWAYS nulls; offer-arrived ALWAYS resets.
        if (event.t === "peer-disconnected")
          expect(actions).toContainEqual({ t: "null-srcobject", id });
        if (event.t === "offer-arrived")
          expect(actions).toContainEqual({ t: "reset-srcobject", id: event.id });

        // Structural invariants on the resulting state.
        for (const slot of Object.values(next.slots)) {
          // A slot can't be "revealed" without a live generation behind it.
          if (slot.revealed) expect(slot.pcGen).toBeGreaterThan(0);
          expect(["new", "connecting", "connected", "disconnected", "failed"]).toContain(slot.conn);
        }

        state = next;
      }

      // Conservation: exactly one null per departure, one reset per offer, per slot.
      for (const id of ids) {
        expect(nulls[id]).toBe(peerGone[id]);
        expect(resets[id]).toBe(offers[id]);
      }
    }
  });

  // Drift guard: the controller proves srcObject is *decided* correctly, but the
  // adapter does the actual write. Assert it has exactly two `srcObject =`
  // assignments — the reset-srcobject and null-srcobject handlers — so a future
  // edit can't reintroduce a rogue write that bypasses the invariant.
  it("receiver.ts writes srcObject in exactly two places", () => {
    const src = readFileSync("src/client/receiver.ts", "utf8");
    const assignments = src.match(/\.srcObject\s*=\s*(?!=)/g) ?? [];
    expect(assignments.length).toBe(2);
  });
});
