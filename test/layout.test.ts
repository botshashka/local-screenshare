import { describe, it, expect } from "vitest";
import {
  initialView,
  resolveView,
  viewReduce,
  computeTiles,
  cycleViews,
  cycleIndex,
  legendFor,
  viewLabel,
  serializeView,
  parseView,
  migrateLegacyView,
  type Tile,
  type ViewEvent,
  type ViewState,
} from "../src/client/layout";
import { SENDER_IDS, type DeviceId } from "../src/client/rtc-utils";

// The receiver's whole view model — which device is focused, in what style, and
// where every tile lands — lives in one pure module precisely so it can be pinned
// down here rather than eyeballed on a TV. The rules under test are the ones a
// person actually feels: the color cycle, panes that don't move when they
// shouldn't, and a grid that tiles the screen exactly.

const [A, B, C, D] = SENDER_IDS;

function press(view: ViewState, index: number, present: readonly DeviceId[]): ViewState {
  return viewReduce(view, { t: "press-color", index }, present);
}

function drive(view: ViewState, events: ViewEvent[], present: readonly DeviceId[]): ViewState {
  return events.reduce((v, e) => viewReduce(v, e, present), view);
}

describe("the color cycle", () => {
  const all = [A, B, C, D];

  it("starts a device's cycle at Only, from the wide view", () => {
    expect(press({ mode: "grid", focus: A }, 2, all)).toEqual({ mode: "only", focus: C });
  });

  it("advances Only → PIP → All on repeated presses of the lit color", () => {
    let v: ViewState = { mode: "grid", focus: A };
    v = press(v, 0, all);
    expect(v).toEqual({ mode: "only", focus: A });
    v = press(v, 0, all);
    expect(v).toEqual({ mode: "pip", focus: A });
    v = press(v, 0, all);
    expect(v).toEqual({ mode: "grid", focus: A });
  });

  it("wraps back to Only, so the cycle is endless on one key", () => {
    // Four presses of red must return exactly where three started it.
    const once = press({ mode: "grid", focus: A }, 0, all);
    const again: ViewEvent = { t: "press-color", index: 0 };
    const round = drive(once, [again, again, again], all);
    expect(round).toEqual(once);
  });

  it("keeps the stage when switching to another device", () => {
    // The corner strip staying up (or staying down) as you flip between devices
    // is the two-device behavior this generalizes — losing it would be a regression.
    expect(press({ mode: "pip", focus: A }, 1, all)).toEqual({ mode: "pip", focus: B });
    expect(press({ mode: "only", focus: A }, 3, all)).toEqual({ mode: "only", focus: D });
  });

  it("is a no-op for a slot nobody has joined", () => {
    const view: ViewState = { mode: "only", focus: A };
    // Identity, not just equality: the adapter skips re-rendering on it, and the
    // legend flash is what makes the dead key legible.
    expect(press(view, 3, [A, B])).toBe(view);
  });

  it("drops PIP from the cycle when there is nothing to put in the corner", () => {
    let v: ViewState = { mode: "grid", focus: A };
    v = press(v, 0, [A]);
    expect(v).toEqual({ mode: "only", focus: A });
    v = press(v, 0, [A]);
    expect(v.mode).toBe("grid");
  });

  it("restores a PIP preference when a second device rejoins", () => {
    // Stored as pip, rendered as only while alone — so the corner strip comes back
    // by itself rather than the preference being quietly rewritten away.
    const view: ViewState = { mode: "pip", focus: A };
    expect(resolveView(view, [A])).toEqual({ mode: "only", focus: A });
    expect(resolveView(view, [A, B])).toBe(view);
  });
});

describe("selecting a pane", () => {
  it("promotes a grid cell to Only", () => {
    expect(viewReduce({ mode: "grid", focus: A }, { t: "select", id: C }, [A, B, C])).toEqual({
      mode: "only",
      focus: C,
    });
  });

  it("swaps focus but stays in PIP when a corner thumbnail is clicked", () => {
    expect(viewReduce({ mode: "pip", focus: A }, { t: "select", id: B }, [A, B, C])).toEqual({
      mode: "pip",
      focus: B,
    });
  });

  it("ignores a device that isn't present", () => {
    const view: ViewState = { mode: "grid", focus: A };
    expect(viewReduce(view, { t: "select", id: D }, [A])).toBe(view);
  });
});

describe("the cycle button", () => {
  it("offers the wide view plus each present device's stages", () => {
    expect(cycleViews([A, B])).toEqual([
      { mode: "grid", focus: A },
      { mode: "only", focus: A },
      { mode: "pip", focus: A },
      { mode: "only", focus: B },
      { mode: "pip", focus: B },
    ]);
  });

  it("skips PIP with a single device", () => {
    expect(cycleViews([A])).toEqual([
      { mode: "grid", focus: A },
      { mode: "only", focus: A },
    ]);
  });

  it("visits every view exactly once and returns to the start", () => {
    const present = [A, B, C];
    const views = cycleViews(present);
    let v: ViewState = views[0]!;
    const seen: string[] = [];
    for (let i = 0; i < views.length; i++) {
      seen.push(serializeView(v));
      v = viewReduce(v, { t: "cycle" }, present);
    }
    expect(new Set(seen).size).toBe(views.length);
    expect(v).toEqual(views[0]);
  });

  it("reports the position the dots indicator draws", () => {
    expect(cycleIndex({ mode: "pip", focus: B }, [A, B])).toBe(4);
    // A stale PIP with one device reads as the Only it renders as.
    expect(cycleIndex({ mode: "pip", focus: A }, [A])).toBe(1);
  });
});

describe("presence changes", () => {
  it("falls back to the wide view when the focused device isn't here", () => {
    expect(resolveView({ mode: "only", focus: B }, [A, C])).toEqual({ mode: "grid", focus: A });
  });

  it("leaves a view alone while its device is still here", () => {
    const view: ViewState = { mode: "pip", focus: B };
    expect(resolveView(view, [A, B])).toBe(view);
  });

  it("keeps a restored view intact before anyone has joined", () => {
    // Otherwise a saved "Device A only" would be thrown away on every cold start,
    // since the page loads with an empty room.
    const view: ViewState = { mode: "only", focus: A };
    expect(resolveView(view, [])).toBe(view);
    expect(resolveView(view, [A])).toBe(view);
  });

  it("restores the saved view once its device finally announces itself", () => {
    // A receiver reload replays each sender as a separate message. Rewriting the
    // stored view on the first arrival would let Device A destroy a saved
    // "Device C only" a moment before Device C even appeared.
    const saved: ViewState = { mode: "pip", focus: C };
    expect(resolveView(saved, [A])).toEqual({ mode: "grid", focus: A });
    expect(resolveView(saved, [A, B])).toEqual({ mode: "grid", focus: A });
    expect(resolveView(saved, [A, B, C])).toBe(saved);
  });

  it("continues a press from what's on screen, not from an overtaken intent", () => {
    // Showing the grid (focus absent) and pressing red must start red's cycle at
    // Only — the same as any other press from the wide view.
    const saved: ViewState = { mode: "pip", focus: C };
    expect(press(saved, 0, [A, B])).toEqual({ mode: "only", focus: A });
  });
});

// ── Geometry ────────────────────────────────────────────────────────────────

function area(t: Tile): number {
  return t.width * t.height;
}

function overlaps(a: Tile, b: Tile): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

function tileFor(tiles: Tile[], key: string): Tile {
  const found = tiles.find((t) => t.key === key);
  expect(found, `no tile for ${key}`).toBeDefined();
  return found!;
}

function inBounds(t: Tile): boolean {
  return t.left >= 0 && t.top >= 0 && t.left + t.width <= 100 && t.top + t.height <= 100;
}

describe("tiles", () => {
  it("lays out nothing before anyone joins", () => {
    expect(computeTiles({ view: initialView, present: [], canJoin: true })).toEqual([]);
  });

  it("gives Only the whole stage", () => {
    const tiles = computeTiles({
      view: { mode: "only", focus: B },
      present: [A, B],
      canJoin: true,
    });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ key: B, top: 0, left: 0, width: 100, height: 100 });
  });

  it("keeps two devices at full-height halves, with the invitation docked", () => {
    // The common setup must look exactly as it did before four slots existed —
    // making the join prompt a third equal cell would have shrunk it.
    const tiles = computeTiles({
      view: { mode: "grid", focus: A },
      present: [A, B],
      canJoin: true,
    });
    expect(tileFor(tiles, A)).toMatchObject({ top: 0, left: 0, width: 50, height: 100 });
    expect(tileFor(tiles, B)).toMatchObject({ top: 0, left: 50, width: 50, height: 100 });
    const join = tileFor(tiles, "join");
    expect(join.kind).toBe("card");
    expect(join.width).toBeLessThan(30);
    expect(inBounds(join)).toBe(true);
  });

  it("gives the invitation a full cell when it completes the grid", () => {
    // One device: a 50/50 with the QR. Three: the empty fourth cell of the 2×2.
    for (const present of [[A], [A, B, C]]) {
      const tiles = computeTiles({ view: { mode: "grid", focus: A }, present, canJoin: true });
      const join = tileFor(tiles, "join");
      expect(join.kind).toBe("cell");
      expect(tiles).toHaveLength(present.length + 1);
      expect(tiles.reduce((sum, t) => sum + area(t), 0)).toBe(100 * 100);
    }
  });

  it("tiles the stage exactly, with no overlap, for every device count", () => {
    for (const present of [[A], [A, B], [A, B, C], [A, B, C, D]]) {
      const tiles = computeTiles({ view: { mode: "grid", focus: A }, present, canJoin: false });
      expect(tiles.every(inBounds)).toBe(true);
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          expect(overlaps(tiles[i]!, tiles[j]!), `${present.length}: ${i}×${j}`).toBe(false);
        }
      }
      // Three panes leave the 2×2's fourth cell empty by design; the rest fill it.
      const covered = tiles.reduce((sum, t) => sum + area(t), 0);
      expect(covered).toBe(present.length === 3 ? 75 * 100 : 100 * 100);
    }
  });

  it("offers no invitation when the room is full or there are no rooms", () => {
    const full = computeTiles({
      view: { mode: "grid", focus: A },
      present: [A, B, C, D],
      canJoin: true,
    });
    expect(full.some((t) => t.key === "join")).toBe(false);
    const local = computeTiles({ view: { mode: "grid", focus: A }, present: [A], canJoin: false });
    expect(local.some((t) => t.key === "join")).toBe(false);
    expect(local[0]).toMatchObject({ width: 100, height: 100 });
  });

  it("floats every other device in a bottom-right strip in PIP", () => {
    const tiles = computeTiles({
      view: { mode: "pip", focus: B },
      present: [A, B, C, D],
      canJoin: true,
    });
    expect(tileFor(tiles, B)).toMatchObject({ width: 100, height: 100, kind: "main" });
    const corners = tiles.filter((t) => t.kind === "corner");
    expect(corners.map((t) => t.key)).toEqual([A, C, D]);
    for (const corner of corners) {
      expect(inBounds(corner)).toBe(true);
      expect(corner.z).toBeGreaterThan(tileFor(tiles, B).z);
      // Bottom-right quadrant, clear of the edges.
      expect(corner.top).toBeGreaterThan(50);
      expect(corner.left + corner.width).toBeLessThan(100);
    }
    // Laid out left to right in slot order, without touching.
    for (let i = 1; i < corners.length; i++) {
      expect(corners[i]!.left).toBeGreaterThan(corners[i - 1]!.left + corners[i - 1]!.width);
    }
    // No invitation competing with the strip — a QR that small can't be scanned.
    expect(tiles.some((t) => t.key === "join")).toBe(false);
  });

  it("shrinks the strip as more devices crowd it", () => {
    const widthWith = (present: DeviceId[]): number =>
      computeTiles({ view: { mode: "pip", focus: A }, present, canJoin: false }).find(
        (t) => t.kind === "corner",
      )!.width;
    expect(widthWith([A, B])).toBeGreaterThan(widthWith([A, B, C]));
    expect(widthWith([A, B, C])).toBeGreaterThan(widthWith([A, B, C, D]));
  });

  it("renders a stale PIP as Only rather than a lone picture with an empty corner", () => {
    const tiles = computeTiles({ view: { mode: "pip", focus: A }, present: [A], canJoin: false });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ key: A, width: 100, height: 100 });
  });
});

// ── Legend ──────────────────────────────────────────────────────────────────

describe("legend", () => {
  it("maps the four remote colors onto the four slots, in order", () => {
    expect(legendFor(initialView, []).map((p) => [p.color, p.id, p.letter])).toEqual([
      ["red", A, "A"],
      ["green", B, "B"],
      ["yellow", C, "C"],
      ["blue", D, "D"],
    ]);
  });

  it("dims the keys that would do nothing", () => {
    const pills = legendFor({ mode: "only", focus: A }, [A, B]);
    expect(pills.map((p) => p.present)).toEqual([true, true, false, false]);
  });

  it("tells the lit key what one more press does", () => {
    const next = (view: ViewState, present: DeviceId[]): (string | null)[] =>
      legendFor(view, present).map((p) => p.next);
    expect(next({ mode: "only", focus: A }, [A, B])).toEqual(["PIP", null, null, null]);
    expect(next({ mode: "pip", focus: A }, [A, B])).toEqual(["All", null, null, null]);
    // With one device PIP isn't in the cycle, so Only points straight at All.
    expect(next({ mode: "only", focus: A }, [A])).toEqual(["All", null, null, null]);
    // Nothing is lit in the wide view — the chip beside the pills names it instead.
    expect(next({ mode: "grid", focus: A }, [A, B])).toEqual([null, null, null, null]);
  });

  it("lights exactly the focused device, and only when one is focused", () => {
    expect(legendFor({ mode: "pip", focus: C }, [A, C]).map((p) => p.active)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(legendFor({ mode: "grid", focus: C }, [A, C]).some((p) => p.active)).toBe(false);
  });

  it("names the current view", () => {
    expect(viewLabel({ mode: "grid", focus: A }, [A, B])).toBe("All screens");
    expect(viewLabel({ mode: "only", focus: B }, [A, B])).toBe("Device B only");
    expect(viewLabel({ mode: "pip", focus: B }, [A, B])).toBe("Device B + corners");
    expect(viewLabel({ mode: "pip", focus: B }, [B])).toBe("Device B only");
  });
});

// ── Persistence ─────────────────────────────────────────────────────────────

describe("persistence", () => {
  it("round-trips every reachable view", () => {
    for (const view of cycleViews([A, B, C, D])) {
      expect(parseView(serializeView(view))).toEqual(view);
    }
  });

  it("rejects anything it didn't write, rather than half-applying it", () => {
    for (const junk of [null, "", "grid", "sideways:device-a", "grid:device-z", "grid:"]) {
      expect(parseView(junk)).toBeNull();
    }
  });

  it("carries the pre-four-device layouts over", () => {
    expect(migrateLegacyView("side-by-side")).toEqual({ mode: "grid", focus: A });
    expect(migrateLegacyView("pip-b")).toEqual({ mode: "pip", focus: B });
    expect(migrateLegacyView("solo-a")).toEqual({ mode: "only", focus: A });
    expect(migrateLegacyView(null)).toBeNull();
    expect(migrateLegacyView("nonsense")).toBeNull();
  });
});
