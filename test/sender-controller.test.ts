import { describe, it, expect } from "vitest";
import {
  senderControllerReduce,
  senderView,
  initialControllerState,
  type SenderControllerState,
  type SenderControllerEvent,
  type SenderControllerAction,
} from "../src/client/sender-controller";

// The sender media-lifecycle controller is pure. These lock in the capture
// generation guards (stale onended / superseded acquisition), the hot-swap vs
// renegotiate decision, and the signaling-blip / retry behavior that the old
// imperative shareBtn handler could not enforce.

function drive(
  state: SenderControllerState,
  ...events: SenderControllerEvent[]
): SenderControllerState {
  return events.reduce((s, e) => senderControllerReduce(s, e).state, state);
}

function actionsFor(
  state: SenderControllerState,
  event: SenderControllerEvent,
): SenderControllerAction[] {
  return senderControllerReduce(state, event).actions;
}

// Drive to a live, connected single capture {gen:1, hasAudio} with a receiver up.
function connected(hasAudio = true): SenderControllerState {
  return drive(
    initialControllerState,
    { t: "receiver-ready" },
    { t: "share-requested" },
    { t: "capture-acquired", gen: 1, hasAudio },
    { t: "connection-changed", phase: "connected" },
  );
}

describe("senderControllerReduce — acquisition", () => {
  it("mints a generation and asks the adapter to acquire on share", () => {
    const { state, actions } = senderControllerReduce(initialControllerState, {
      t: "share-requested",
    });
    expect(actions).toEqual([{ t: "acquire-capture", gen: 1 }]);
    expect(state.pendingGen).toBe(1);
    expect(state.nextGen).toBe(2);
  });

  it("first share with no receiver holds the capture and waits (no offer)", () => {
    const s = drive(initialControllerState, { t: "share-requested" });
    const { state, actions } = senderControllerReduce(s, {
      t: "capture-acquired",
      gen: 1,
      hasAudio: true,
    });
    expect(actions).toEqual([
      { t: "use-capture", gen: 1 },
      { t: "attach-preview", gen: 1 },
    ]);
    expect(state.capture).toEqual({ gen: 1, hasAudio: true });
    expect(state.conn).toBe("idle");
  });

  it("first share with a receiver up renegotiates", () => {
    const s = drive(initialControllerState, { t: "receiver-ready" }, { t: "share-requested" });
    const { state, actions } = senderControllerReduce(s, {
      t: "capture-acquired",
      gen: 1,
      hasAudio: true,
    });
    expect(actions).toEqual([
      { t: "use-capture", gen: 1 },
      { t: "attach-preview", gen: 1 },
      { t: "renegotiate" },
    ]);
    expect(state.conn).toBe("connecting");
  });

  it("stops a superseded acquisition (double-click race) without making it live", () => {
    const s = drive(
      initialControllerState,
      { t: "share-requested" }, // gen 1
      { t: "share-requested" }, // gen 2 supersedes
    );
    expect(actionsFor(s, { t: "capture-acquired", gen: 1, hasAudio: true })).toEqual([
      { t: "stop-capture", gen: 1 },
    ]);
    // The current request still attaches.
    const after = drive(s, { t: "capture-acquired", gen: 1, hasAudio: true });
    expect(after.capture).toBeNull();
    const { state } = senderControllerReduce(after, {
      t: "capture-acquired",
      gen: 2,
      hasAudio: true,
    });
    expect(state.capture).toEqual({ gen: 2, hasAudio: true });
  });

  it("cancelling a re-share picker keeps the existing share alive", () => {
    const s = drive(connected(), { t: "share-requested" }); // pendingGen 2
    const { state, actions } = senderControllerReduce(s, { t: "capture-failed", gen: 2 });
    expect(actions).toEqual([]);
    expect(state.pendingGen).toBeNull();
    expect(state.capture).toEqual({ gen: 1, hasAudio: true }); // untouched
  });

  it("ignores a stale capture-failed", () => {
    const s = connected();
    expect(actionsFor(s, { t: "capture-failed", gen: 99 })).toEqual([]);
  });
});

describe("senderControllerReduce — hot-swap vs renegotiate", () => {
  it("hot-swaps a re-share over a live connection (audio unchanged)", () => {
    const s = drive(connected(true), { t: "share-requested" }); // pendingGen 2
    const { state, actions } = senderControllerReduce(s, {
      t: "capture-acquired",
      gen: 2,
      hasAudio: true,
    });
    expect(actions).toEqual([
      { t: "use-capture", gen: 2 },
      { t: "attach-preview", gen: 2 },
      { t: "swap-tracks", gen: 2, retireGen: 1 },
    ]);
    expect(state.conn).toBe("connected"); // unchanged — no teardown
    expect(state.capture).toEqual({ gen: 2, hasAudio: true });
  });

  it("renegotiates (not hot-swap) when audio presence flips: audio→none→audio", () => {
    // audio → none
    let s = drive(connected(true), { t: "share-requested" }); // pendingGen 2
    let r = senderControllerReduce(s, { t: "capture-acquired", gen: 2, hasAudio: false });
    expect(r.actions).toEqual([
      { t: "use-capture", gen: 2 },
      { t: "attach-preview", gen: 2 },
      { t: "stop-capture", gen: 1 },
      { t: "renegotiate" },
    ]);
    // none → audio
    s = drive(r.state, { t: "connection-changed", phase: "connected" }, { t: "share-requested" });
    r = senderControllerReduce(s, { t: "capture-acquired", gen: 3, hasAudio: true });
    expect(r.actions).toContainEqual({ t: "renegotiate" });
    expect(r.actions).not.toContainEqual(
      expect.objectContaining({ t: "swap-tracks" }) as unknown as SenderControllerAction,
    );
  });

  it("does NOT hot-swap a re-share while a renegotiation is still connecting", () => {
    // receiver up, first share in flight (conn === connecting, not connected)
    const s = drive(
      initialControllerState,
      { t: "receiver-ready" },
      { t: "share-requested" },
      { t: "capture-acquired", gen: 1, hasAudio: true }, // → connecting
      { t: "share-requested" }, // pendingGen 2
    );
    expect(s.conn).toBe("connecting");
    const actions = actionsFor(s, { t: "capture-acquired", gen: 2, hasAudio: true });
    expect(actions).toEqual([
      { t: "use-capture", gen: 2 },
      { t: "attach-preview", gen: 2 },
      { t: "stop-capture", gen: 1 },
      { t: "renegotiate" },
    ]);
  });
});

describe("senderControllerReduce — capture ended", () => {
  it("tears down when the live capture ends", () => {
    const s = connected();
    const { state, actions } = senderControllerReduce(s, { t: "capture-ended", gen: 1 });
    expect(actions).toEqual([{ t: "stop-capture", gen: 1 }, { t: "teardown-peer" }]);
    expect(state.capture).toBeNull();
    expect(state.conn).toBe("idle");
  });

  it("IGNORES a stale capture's end after a re-share (the original bug)", () => {
    // Re-share to gen 2 while connected, then the OLD gen-1 capture's onended fires.
    const s = drive(connected(true), { t: "share-requested" }, {
      t: "capture-acquired",
      gen: 2,
      hasAudio: true,
    });
    expect(s.capture).toEqual({ gen: 2, hasAudio: true });
    const { state, actions } = senderControllerReduce(s, { t: "capture-ended", gen: 1 });
    expect(actions).toEqual([]); // not torn down
    expect(state.capture).toEqual({ gen: 2, hasAudio: true });
  });
});

describe("senderControllerReduce — signaling lifecycle", () => {
  it("socket-down keeps capture + conn, only clears receiverReady", () => {
    const s = connected();
    const { state, actions } = senderControllerReduce(s, { t: "socket-down" });
    expect(actions).toEqual([]);
    expect(state.capture).toEqual({ gen: 1, hasAudio: true });
    expect(state.conn).toBe("connected"); // P2P media survives
    expect(state.receiverReady).toBe(false);
  });

  it("re-share during a signaling outage still hot-swaps over live P2P", () => {
    const s = drive(connected(true), { t: "socket-down" }, { t: "share-requested" });
    const actions = actionsFor(s, { t: "capture-acquired", gen: 2, hasAudio: true });
    expect(actions).toContainEqual({ t: "swap-tracks", gen: 2, retireGen: 1 });
  });

  it("receiver-ready after reconnect renegotiates the live capture", () => {
    const s = drive(connected(), { t: "socket-down" });
    const { actions } = senderControllerReduce(s, { t: "receiver-ready" });
    expect(actions).toEqual([{ t: "use-capture", gen: 1 }, { t: "renegotiate" }]);
  });

  it("receiver-gone tears down and forgets the receiver", () => {
    const s = connected();
    const { state, actions } = senderControllerReduce(s, { t: "receiver-gone" });
    expect(actions).toEqual([{ t: "teardown-peer" }]);
    expect(state.receiverReady).toBe(false);
    expect(state.conn).toBe("idle");
  });

  it("reoffer-requested renegotiates only when a capture is live", () => {
    expect(actionsFor(initialControllerState, { t: "reoffer-requested" })).toEqual([]);
    const { actions } = senderControllerReduce(connected(), { t: "reoffer-requested" });
    expect(actions).toEqual([{ t: "use-capture", gen: 1 }, { t: "renegotiate" }]);
  });
});

describe("senderControllerReduce — connection + retry", () => {
  it("schedules exactly one retry on failure", () => {
    const s = connected();
    const first = senderControllerReduce(s, { t: "connection-failed" });
    expect(first.actions).toEqual([{ t: "schedule-retry" }]);
    expect(first.state.retryPending).toBe(true);
    expect(senderControllerReduce(first.state, { t: "connection-failed" }).actions).toEqual([]);
  });

  it("cancels a pending retry when the connection comes up", () => {
    const failed = drive(connected(), { t: "connection-failed" });
    const { state, actions } = senderControllerReduce(failed, {
      t: "connection-changed",
      phase: "connected",
    });
    expect(actions).toEqual([{ t: "cancel-retry" }]);
    expect(state.retryPending).toBe(false);
  });

  it("retry fires a renegotiation only with a capture and a receiver", () => {
    const failed = drive(connected(), { t: "connection-failed" });
    expect(senderControllerReduce(failed, { t: "retry-fired" }).actions).toEqual([
      { t: "use-capture", gen: 1 },
      { t: "renegotiate" },
    ]);
    // After a signaling drop (no receiver), the same retry is a no-op.
    const noReceiver = drive(failed, { t: "socket-down" });
    expect(senderControllerReduce(noReceiver, { t: "retry-fired" }).actions).toEqual([]);
  });
});

describe("senderControllerReduce — renegotiate invariant", () => {
  // Every renegotiate must be the last action and be preceded by a use-capture
  // pointing at the resulting live capture, so the next PC is provably built from
  // the current source (HIGH-4). Exercise every path that can emit one.
  const paths: Array<[string, SenderControllerState, SenderControllerEvent]> = [
    ["first share w/ receiver", drive(initialControllerState, { t: "receiver-ready" }, { t: "share-requested" }), { t: "capture-acquired", gen: 1, hasAudio: true }],
    ["re-share audio flip", drive(connected(true), { t: "share-requested" }), { t: "capture-acquired", gen: 2, hasAudio: false }],
    ["receiver-ready", connected(), { t: "receiver-ready" }],
    ["reoffer-requested", connected(), { t: "reoffer-requested" }],
    ["retry-fired", drive(connected(), { t: "connection-failed" }), { t: "retry-fired" }],
  ];

  for (const [name, state, event] of paths) {
    it(`${name}: renegotiate is terminal and preceded by use-capture`, () => {
      const { state: next, actions } = senderControllerReduce(state, event);
      const idx = actions.findIndex((a) => a.t === "renegotiate");
      expect(idx).toBe(actions.length - 1); // terminal
      const use = actions.find((a) => a.t === "use-capture");
      expect(use).toBeDefined();
      expect((use as { gen: number }).gen).toBe(next.capture?.gen);
    });
  }
});

describe("senderView", () => {
  it("blank when nothing is happening (adapter overlays signaling status)", () => {
    expect(senderView(initialControllerState)).toEqual({ status: "", cls: "", favicon: "grey" });
  });

  it("amber + prompt when the receiver is up but nothing is shared", () => {
    const s = drive(initialControllerState, { t: "receiver-ready" });
    expect(senderView(s)).toMatchObject({ cls: "connected", favicon: "amber" });
  });

  it("waiting when a capture is held but no receiver", () => {
    const s = drive(initialControllerState, { t: "share-requested" }, {
      t: "capture-acquired",
      gen: 1,
      hasAudio: true,
    });
    expect(senderView(s)).toEqual({ status: "Waiting for TV receiver…", cls: "", favicon: "grey" });
  });

  it("green + streaming when connected", () => {
    expect(senderView(connected())).toEqual({
      status: "Streaming to TV",
      cls: "connected",
      favicon: "green",
    });
  });

  it("error while retrying", () => {
    const s = drive(connected(), { t: "connection-failed" });
    expect(senderView(s)).toMatchObject({ status: "Connection failed — retrying…", cls: "error" });
  });
});

describe("senderControllerReduce — transition corners", () => {
  it("receiver-gone from idle is a harmless teardown", () => {
    const { state, actions } = senderControllerReduce(initialControllerState, { t: "receiver-gone" });
    expect(actions).toEqual([{ t: "teardown-peer" }]);
    expect(state.capture).toBeNull();
    expect(state.conn).toBe("idle");
  });

  it("connection-changed{connecting} advances the phase without actions", () => {
    const s = drive(initialControllerState, { t: "receiver-ready" }, { t: "share-requested" }, {
      t: "capture-acquired",
      gen: 1,
      hasAudio: true,
    });
    // already connecting after the renegotiate; a connecting event is a no-op echo
    const { state, actions } = senderControllerReduce(s, {
      t: "connection-changed",
      phase: "connecting",
    });
    expect(actions).toEqual([]);
    expect(state.conn).toBe("connecting");
  });

  it("a stale capture-acquired stops only the orphan, never the live capture", () => {
    const live = connected(true); // capture gen 1, connected
    const s = drive(live, { t: "share-requested" }); // pendingGen 2
    // A late gen-1 acquisition (impossible in practice, but the guard must hold):
    const { state, actions } = senderControllerReduce(s, {
      t: "capture-acquired",
      gen: 99,
      hasAudio: true,
    });
    expect(actions).toEqual([{ t: "stop-capture", gen: 99 }]);
    expect(state.capture).toEqual({ gen: 1, hasAudio: true }); // untouched
    expect(state.pendingGen).toBe(2); // still awaiting gen 2
  });

  it("retry-fired with no capture at all is a no-op", () => {
    const s = drive(initialControllerState, { t: "receiver-ready" }, { t: "connection-failed" });
    // connection-failed with no capture still schedules (adapter wouldn't fire it,
    // but the guard is what matters); the retry then finds nothing to do.
    expect(senderControllerReduce(s, { t: "retry-fired" }).actions).toEqual([]);
  });
});

// ── Exhaustive property / fuzz coverage ─────────────────────────────────────
// Random event sequences must never break the structural invariants the adapter
// relies on — most importantly that every renegotiate is preceded by a
// use-capture for the resulting capture (HIGH-4), and that renegotiate/swap-tracks
// are mutually exclusive and terminal. A seeded LCG keeps failures reproducible.
describe("senderControllerReduce — invariants under random sequences", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  // Build a random event, biasing gens toward the live/pending ones so staleness
  // and currency are both exercised.
  function randomEvent(rng: () => number, s: SenderControllerState): SenderControllerEvent {
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const someGen = (): number =>
      pick([s.pendingGen ?? 0, s.capture?.gen ?? 0, s.nextGen, s.nextGen - 1, 1, 2, 99]);
    const kind = pick([
      "share-requested",
      "capture-acquired",
      "capture-failed",
      "capture-ended",
      "receiver-ready",
      "receiver-gone",
      "socket-down",
      "reoffer-requested",
      "connection-connecting",
      "connection-connected",
      "connection-failed",
      "retry-fired",
    ] as const);
    switch (kind) {
      case "capture-acquired":
        return { t: "capture-acquired", gen: someGen(), hasAudio: rng() < 0.5 };
      case "capture-failed":
        return { t: "capture-failed", gen: someGen() };
      case "capture-ended":
        return { t: "capture-ended", gen: someGen() };
      case "connection-connecting":
        return { t: "connection-changed", phase: "connecting" };
      case "connection-connected":
        return { t: "connection-changed", phase: "connected" };
      default:
        return { t: kind };
    }
  }

  function checkStep(
    before: SenderControllerState,
    actions: SenderControllerAction[],
    after: SenderControllerState,
  ): void {
    // Generations are monotonic and pendingGen is always a real, in-range gen.
    expect(after.nextGen).toBeGreaterThanOrEqual(before.nextGen);
    if (after.pendingGen !== null) {
      expect(after.pendingGen).toBeGreaterThan(0);
      expect(after.pendingGen).toBeLessThan(after.nextGen);
    }
    expect(["idle", "connecting", "connected"]).toContain(after.conn);

    const reneg = actions.findIndex((a) => a.t === "renegotiate");
    const swap = actions.findIndex((a) => a.t === "swap-tracks");

    // renegotiate and swap-tracks are mutually exclusive ways to bring a capture
    // online.
    expect(reneg === -1 || swap === -1).toBe(true);

    if (reneg !== -1) {
      expect(reneg).toBe(actions.length - 1); // terminal
      const use = actions.slice(0, reneg).find((a) => a.t === "use-capture");
      expect(use, "renegotiate must be preceded by a use-capture").toBeDefined();
      expect((use as { gen: number }).gen).toBe(after.capture?.gen);
      expect(after.capture).not.toBeNull();
    }
    if (swap !== -1) {
      expect(swap).toBe(actions.length - 1); // terminal
      const swapAction = actions[swap] as { gen: number; retireGen: number };
      expect(swapAction.gen).toBe(after.capture?.gen);
      expect(swapAction.retireGen).not.toBe(swapAction.gen); // retiring a *different* capture
      const use = actions.slice(0, swap).find((a) => a.t === "use-capture");
      expect(use, "swap-tracks must be preceded by a use-capture").toBeDefined();
    }

    // acquire-capture is only minted by share-requested, tagged with the new pending gen.
    for (const a of actions) {
      if (a.t === "acquire-capture") expect(a.gen).toBe(after.pendingGen);
      if (a.t === "use-capture") expect(a.gen).toBe(after.capture?.gen);
    }
  }

  it("holds across 4000 random steps over 8 seeds", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rng = lcg(seed * 2654435761);
      let state = initialControllerState;
      for (let i = 0; i < 500; i++) {
        const event = randomEvent(rng, state);
        const { state: next, actions } = senderControllerReduce(state, event);
        checkStep(state, actions, next);
        state = next;
      }
    }
  });
});
