import { describe, it, expect } from "vitest";
import {
  onMessage,
  onClose,
  sweep,
  type Attach,
  type ConnKey,
  type Snapshot,
  type SignalMsg,
  type Op,
} from "../../src/core/room";

// The pure hub core, driven against a trivial in-memory registry. No sockets, no
// timers, no wall-clock sleeps — so this is both the authoritative logic suite and
// far faster/steadier than the per-runtime socket suites it replaces. Each helper
// applies the returned ops to the registry exactly as a real adapter would, so
// multi-step scenarios (reclaim, reap, re-register) play out faithfully.

class Room {
  conns = new Map<ConnKey, Attach>();
  sends: { to: ConnKey; msg: SignalMsg }[] = [];
  closes: { key: ConnKey; kind: string }[] = [];

  connect(now = 0): ConnKey {
    const key: ConnKey = {};
    // Frozen so any attempt by the core to mutate an attachment in-place (it must
    // treat the snapshot as immutable) throws instead of passing silently.
    this.conns.set(key, Object.freeze({ id: null, seen: now, token: "" }));
    return key;
  }

  private snapshot(): Snapshot {
    return { conns: [...this.conns].map(([key, attach]) => ({ key, attach })) };
  }

  private apply(ops: Op[]): Op[] {
    for (const op of ops) {
      if (op.op === "send") this.sends.push({ to: op.to, msg: op.msg as SignalMsg });
      else if (op.op === "attach") this.conns.set(op.key, Object.freeze(op.attach));
      else if (op.op === "close") {
        this.closes.push({ key: op.key, kind: op.kind });
        this.conns.delete(op.key); // transport gone
      }
    }
    return ops;
  }

  msg(self: ConnKey, msg: SignalMsg, now = 0, timeoutMs?: number): Op[] {
    return this.apply(onMessage(this.snapshot(), self, msg, now, timeoutMs).ops);
  }

  close(self: ConnKey): Op[] {
    return this.apply(onClose(this.snapshot(), self).ops);
  }

  sweep(now: number, timeoutMs?: number): Op[] {
    return this.apply(sweep(this.snapshot(), now, timeoutMs).ops);
  }

  idOf(key: ConnKey): string | null {
    return this.conns.get(key)?.id ?? null;
  }

  // Messages delivered to `key`, in order.
  inbox(key: ConnKey): SignalMsg[] {
    return this.sends.filter((s) => s.to === key).map((s) => s.msg);
  }
}

function register(room: Room, key: ConnKey, fields: Partial<SignalMsg>, now = 0): void {
  room.msg(key, { type: "register", ...fields }, now);
}

function assignedId(room: Room, key: ConnKey): string | undefined {
  const msg = room.inbox(key).find((m) => m.type === "assigned");
  return msg?.id;
}

describe("slot assignment", () => {
  it("assigns device-a then device-b by arrival order", () => {
    const room = new Room();
    const a = room.connect();
    const b = room.connect();
    register(room, a, { role: "sender" });
    register(room, b, { role: "sender" });
    expect(assignedId(room, a)).toBe("device-a");
    expect(assignedId(room, b)).toBe("device-b");
  });

  it("honors a free prefer hint", () => {
    const room = new Room();
    const s = room.connect();
    register(room, s, { role: "sender", prefer: "device-b" });
    expect(assignedId(room, s)).toBe("device-b");
  });

  it("turns a fresh third sender away with room-full (no stealing)", () => {
    const room = new Room();
    const a = room.connect();
    const b = room.connect();
    const c = room.connect();
    register(room, a, { role: "sender", token: "ta" });
    register(room, b, { role: "sender", token: "tb" });
    register(room, c, { role: "sender", token: "tc" });
    expect(room.inbox(c).some((m) => m.type === "room-full")).toBe(true);
    expect(assignedId(room, c)).toBeUndefined();
  });
});

describe("prefer reclaim (the 'no Share button' ghost bug)", () => {
  it("reclaims a slot still held by a ghost (same token) instead of room-full", () => {
    const room = new Room();
    const ghost = room.connect(0);
    register(room, ghost, { role: "sender", prefer: "device-a", token: "tab" }, 0);
    expect(assignedId(room, ghost)).toBe("device-a");

    // The same tab reconnects (a fresh socket, same token) while its ghost lingers.
    const fresh = room.connect(1);
    register(room, fresh, { role: "sender", prefer: "device-a", token: "tab" }, 1);
    expect(assignedId(room, fresh)).toBe("device-a");
    // The ghost was replaced, not left holding the slot.
    expect(room.closes.some((c) => c.key === ghost && c.kind === "replace")).toBe(true);
    expect(room.idOf(fresh)).toBe("device-a");
  });
});

describe("token-gated reclaim (the two-tab livelock)", () => {
  it("a different live device cannot evict a slot it also prefers", () => {
    const room = new Room();
    const a = room.connect();
    register(room, a, { role: "sender", prefer: "device-a", token: "tab-A" });
    expect(assignedId(room, a)).toBe("device-a");

    const b = room.connect();
    register(room, b, { role: "sender", prefer: "device-a", token: "tab-B" });
    // B is slotted beside A, not in place of it.
    expect(assignedId(room, b)).toBe("device-b");
    expect(room.idOf(a)).toBe("device-a");
  });

  it("still reclaims its own ghost when the token matches", () => {
    const room = new Room();
    const ghost = room.connect();
    register(room, ghost, { role: "sender", prefer: "device-a", token: "mine" });
    const fresh = room.connect();
    register(room, fresh, { role: "sender", prefer: "device-a", token: "mine" });
    expect(assignedId(room, fresh)).toBe("device-a");
  });

  it("a socket re-registering to a different slot frees the one it held", () => {
    const room = new Room();
    const s = room.connect();
    register(room, s, { role: "sender", prefer: "device-a", token: "t" });
    expect(room.idOf(s)).toBe("device-a");
    // Re-register preferring device-b: it moves, freeing device-a.
    register(room, s, { role: "sender", prefer: "device-b", token: "t" });
    expect(room.idOf(s)).toBe("device-b");
    // device-a is now free for a newcomer.
    const n = room.connect();
    register(room, n, { role: "sender", token: "n" });
    expect(assignedId(room, n)).toBe("device-a");
  });
});

describe("close guard", () => {
  it("a replaced ghost's later close does not evict its successor", () => {
    const room = new Room();
    const ghost = room.connect();
    register(room, ghost, { role: "sender", prefer: "device-a", token: "tab" });
    const fresh = room.connect();
    register(room, fresh, { role: "sender", prefer: "device-a", token: "tab" });
    // The ghost's transport finally closes — must be a no-op (its attach was nulled
    // on replace, so onClose sees it as unregistered).
    room.conns.set(ghost, { id: null, seen: 0, token: "" }); // as the adapter left it
    const ops = room.close(ghost);
    expect(ops).toEqual([]);
    expect(room.idOf(fresh)).toBe("device-a");
  });
});

describe("pairing and relay", () => {
  it("pairs a sender that arrives before the receiver, receiver-first ordering", () => {
    const room = new Room();
    const s = room.connect();
    register(room, s, { role: "sender", token: "s" });
    const r = room.connect();
    register(room, r, { id: "receiver" });

    // The receiver learns of the sender, then the sender is told to (re)offer.
    expect(room.inbox(r).some((m) => m.type === "sender-connected" && m.id === "device-a")).toBe(
      true,
    );
    expect(room.inbox(s).some((m) => m.type === "receiver-ready")).toBe(true);
  });

  it("relays an addressed frame, stamping from with the sender's registered id (spoof ignored)", () => {
    const room = new Room();
    const s = room.connect();
    register(room, s, { role: "sender", token: "s" });
    const r = room.connect();
    register(room, r, { id: "receiver" });

    room.msg(s, { type: "offer", to: "receiver", from: "device-b", sdp: "SDP" });
    const offer = room.inbox(r).find((m) => m.type === "offer");
    expect(offer?.from).toBe("device-a"); // spoofed "device-b" overwritten
    expect(offer?.sdp).toBe("SDP");
  });

  it("drops a relay from a socket that hasn't registered", () => {
    const room = new Room();
    const r = room.connect();
    register(room, r, { id: "receiver" });
    const rogue = room.connect();
    room.msg(rogue, { type: "offer", to: "receiver", sdp: "X" });
    expect(room.inbox(r).some((m) => m.type === "offer")).toBe(false);
  });

  it("drops an addressed frame when the target is absent", () => {
    const room = new Room();
    const s = room.connect();
    register(room, s, { role: "sender", token: "s" });
    const ops = room.msg(s, { type: "offer", to: "receiver", sdp: "X" });
    expect(ops.some((o) => o.op === "send" && (o.msg as SignalMsg).type === "offer")).toBe(false);
  });
});

describe("disconnect", () => {
  it("notifies the receiver when a sender drops", () => {
    const room = new Room();
    const s = room.connect();
    register(room, s, { role: "sender", token: "s" });
    const r = room.connect();
    register(room, r, { id: "receiver" });
    room.close(s);
    expect(room.inbox(r).some((m) => m.type === "peer-disconnected" && m.id === "device-a")).toBe(
      true,
    );
  });

  it("notifies live senders when the receiver drops", () => {
    const room = new Room();
    const a = room.connect();
    register(room, a, { role: "sender", token: "a" });
    const b = room.connect();
    register(room, b, { role: "sender", token: "b" });
    const r = room.connect();
    register(room, r, { id: "receiver" });
    room.close(r);
    expect(room.inbox(a).some((m) => m.type === "peer-disconnected" && m.id === "receiver")).toBe(
      true,
    );
    expect(room.inbox(b).some((m) => m.type === "peer-disconnected" && m.id === "receiver")).toBe(
      true,
    );
  });
});

describe("liveness", () => {
  it("replies to a ping with a pong", () => {
    const room = new Room();
    const s = room.connect();
    register(room, s, { role: "sender", token: "s" });
    const ops = room.msg(s, { type: "ping" }, 1000);
    expect(ops.some((o) => o.op === "send" && (o.msg as SignalMsg).type === "pong")).toBe(true);
  });

  it("leaves a just-connected socket alone on sweep", () => {
    const room = new Room();
    const s = room.connect(0);
    register(room, s, { role: "sender", token: "s" }, 0);
    const ops = room.sweep(5_000, 30_000); // well within the timeout
    expect(ops).toEqual([]);
    expect(room.idOf(s)).toBe("device-a");
  });

  it("reaps a silent socket and tells its peer it disconnected", () => {
    const room = new Room();
    const s = room.connect(0);
    register(room, s, { role: "sender", token: "s" }, 0);
    const r = room.connect(0);
    register(room, r, { id: "receiver" }, 0);
    // The receiver pings later (keeping it fresh); the sender stays silent.
    room.msg(r, { type: "ping" }, 100_000, 30_000);
    expect(room.inbox(r).some((m) => m.type === "peer-disconnected" && m.id === "device-a")).toBe(
      true,
    );
    expect(room.idOf(s)).toBeNull();
  });

  it("a fresh sender reclaims a slot once the ghost holding it times out", () => {
    const room = new Room();
    const ghost = room.connect(0);
    register(room, ghost, { role: "sender", prefer: "device-a", token: "old" }, 0);
    // A different device (different token) registers much later — the sweep at the
    // top of its register reaps the silent ghost, freeing device-a.
    const fresh = room.connect(100_000);
    register(room, fresh, { role: "sender", prefer: "device-a", token: "new" }, 100_000);
    expect(assignedId(room, fresh)).toBe("device-a");
    expect(room.closes.some((c) => c.key === ghost && c.kind === "reap")).toBe(true);
  });
});

describe("op ordering (hibernation-safe)", () => {
  it("emits attach(null) before close for a replaced socket", () => {
    const room = new Room();
    const ghost = room.connect();
    register(room, ghost, { role: "sender", prefer: "device-a", token: "tab" });
    const fresh = room.connect();
    const ops = onMessage(
      { conns: [...room.conns].map(([key, attach]) => ({ key, attach })) },
      fresh,
      { type: "register", role: "sender", prefer: "device-a", token: "tab" },
      1,
    ).ops;
    const attachNull = ops.findIndex(
      (o) => o.op === "attach" && o.key === ghost && o.attach.id === null,
    );
    const close = ops.findIndex((o) => o.op === "close" && o.key === ghost);
    expect(attachNull).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(attachNull);
  });
});

// ── Exhaustive property / fuzz coverage ─────────────────────────────────────
// The core is the SINGLE source of truth both runtimes share, so its invariants
// are the ones a drift would break. Random sequences of connect / register / relay
// / ping / close / sweep across multiple sockets must always preserve: at most one
// live holder per id, only valid ids ever assigned, an "assigned" reply matching
// the slot the socket ends up holding, and the hibernation-safe op ordering
// (attach-null strictly before the matching close). Attachments are frozen
// (see the Room helper) so any in-place mutation of the snapshot throws — that is
// the purity guarantee encoded as a runtime check.
describe("core invariants under random sequences", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  const VALID_IDS = new Set(["device-a", "device-b", "receiver"]);
  const TIMEOUT = 30_000;

  // Every close (reap or replace) must be preceded in the SAME op list by an
  // attach nulling that key — else a closing socket's own handler still sees it
  // registered and double-announces.
  function checkOpOrdering(ops: Op[]): void {
    ops.forEach((op, i) => {
      if (op.op !== "close") return;
      const nulledBefore = ops
        .slice(0, i)
        .some((o) => o.op === "attach" && o.key === op.key && o.attach.id === null);
      expect(nulledBefore, "close must be preceded by attach(null) for the same key").toBe(true);
    });
  }

  function checkRoom(room: Room): void {
    const ids = [...room.conns.values()].map((a) => a.id).filter((id): id is string => id !== null);
    for (const id of ids) expect(VALID_IDS.has(id)).toBe(true);
    // At most one live holder per id (so ≤2 senders + 1 receiver, never a duplicate).
    expect(new Set(ids).size).toBe(ids.length);
  }

  it("holds across 8 seeds × 400 random steps", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rng = lcg(seed * 2654435761);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
      const room = new Room();
      const keys: ConnKey[] = [];
      const tokens = ["t0", "t1", "t2", ""];
      const targets = ["device-a", "device-b", "receiver", "nobody"];
      let now = 0;

      for (let i = 0; i < 400; i++) {
        now += Math.floor(rng() * 12_000); // sometimes past the 30s timeout → reaps
        const action = pick([
          "connect",
          "register-sender",
          "register-receiver",
          "relay",
          "ping",
          "close",
          "sweep",
        ] as const);

        if (action === "connect") {
          if (keys.length < 5) keys.push(room.connect(now));
          continue;
        }
        if (action === "sweep") {
          checkOpOrdering(room.sweep(now, TIMEOUT));
          checkRoom(room);
          continue;
        }
        if (!keys.length) continue;
        const k = pick(keys);

        switch (action) {
          case "register-sender": {
            const prefer = pick([undefined, "device-a", "device-b"]);
            const ops = room.msg(
              k,
              { type: "register", role: "sender", token: pick(tokens), ...(prefer ? { prefer } : {}) },
              now,
              TIMEOUT,
            );
            checkOpOrdering(ops);
            const assigned = ops.find((o) => o.op === "send" && (o.msg as SignalMsg).type === "assigned");
            // A slot assignment is honored: the socket ends up holding exactly it.
            if (assigned && assigned.op === "send") {
              expect(room.idOf(k)).toBe((assigned.msg as SignalMsg).id);
            }
            break;
          }
          case "register-receiver": {
            const ops = room.msg(k, { type: "register", id: "receiver" }, now, TIMEOUT);
            checkOpOrdering(ops);
            // The receiver is "newest wins" — registering a live socket always claims it.
            if (room.conns.has(k)) expect(room.idOf(k)).toBe("receiver");
            break;
          }
          case "relay":
            checkOpOrdering(
              room.msg(k, { type: "offer", to: pick(targets), sdp: "SDP" }, now, TIMEOUT),
            );
            break;
          case "ping":
            checkOpOrdering(room.msg(k, { type: "ping" }, now, TIMEOUT));
            break;
          case "close":
            checkOpOrdering(room.close(k));
            break;
        }
        checkRoom(room);
      }
    }
  });
});
