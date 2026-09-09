// Pure receiver view model: which device is focused, in what style, and where
// every tile sits on the stage. The adapter in receiver.ts owns the DOM and
// applies what this returns — no layout decision is made there. Geometry is
// computed as percentages of the stage and applied inline, which is what makes
// every arrangement unit-testable instead of eyeball-testable.
//
// THE REMOTE MODEL — one rule, no extra buttons. The TV's four color keys own
// the four sender slots (red/green/yellow/blue = A/B/C/D). Pressing a color you
// are not on focuses that device *keeping the current stage*; pressing the color
// you are already on advances that device's cycle:
//
//     Only ──▶ PIP ──▶ All (grid) ──▶ Only ──▶ …
//
// STORED INTENT vs EFFECTIVE VIEW. What the user last chose is kept verbatim;
// what's actually on screen is derived from it and the current state by
// `resolveView`, at read time. Nothing ever rewrites the stored view in response
// to a presence change — which matters because presence is constantly in flux:
// a receiver reload replays every sender as a separate message, so rewriting on
// each one would let the first arrival (not the saved device) wipe the saved
// view before the saved device had even announced itself. Resolving instead
// means the view snaps back the moment its device reappears.
//
// Three things get resolved away: a focus on a device that isn't here, a focus
// on a device that has joined but isn't sending frames while another one is
// (see resolveView), and PIP with nobody to put in the corner.

import { SENDER_IDS, deviceLabel, isDeviceId, type DeviceId } from "./rtc-utils.js";

export type ViewMode = "only" | "pip" | "grid";

export interface ViewState {
  mode: ViewMode;
  // The device the color cycle is "on". Meaningless in `grid`, which ignores it
  // and which resolveView canonicalizes to the first present device.
  focus: DeviceId;
}

export const initialView: ViewState = { mode: "grid", focus: "device-a" };

// What the stored view actually means right now. `present` is every sender the
// hub says is in the room; `live` is the subset actually sending frames. Returns
// the same object when the stored view is already what's on screen.
export function resolveView(
  view: ViewState,
  present: readonly DeviceId[],
  live: readonly DeviceId[] = present,
): ViewState {
  // Nothing to lay out yet: keep the restored intent intact so a saved
  // "Device A only" still applies the moment Device A arrives.
  if (present.length === 0) return view;
  const wide: ViewState = { mode: "grid", focus: present[0]! };
  // Canonicalize grid's carried focus, so the effective view is always one
  // `cycleViews` emits and the dots indicator can always find it.
  if (view.mode === "grid") return view.focus === present[0] ? view : wide;
  // The grid is the only honest thing to show when the subject is gone.
  if (!present.includes(view.focus)) return wide;
  // Joined is not streaming — senders register with the hub on page load, before
  // they pick a window. A full-stage waiting ring must never bury a picture that
  // is live, so fall back to the wide view; but only when there IS one to bury,
  // so focusing a device before anyone shares still shows that it was focused.
  if (live.length > 0 && !live.includes(view.focus)) return wide;
  if (view.mode === "pip" && present.length < 2) return { mode: "only", focus: view.focus };
  return view;
}

// The cycle a single device's color key walks, shortest-first. `grid` is always
// last so one more press of the lit color always lands back on the wide view.
function stagesFor(present: readonly DeviceId[]): ViewMode[] {
  return present.length < 2 ? ["only", "grid"] : ["only", "pip", "grid"];
}

export type ViewEvent =
  // A TV color key, or its r-g-y-b / 1-4 keyboard equivalent.
  | { t: "press-device"; id: DeviceId }
  // The on-screen layout button / L / Space — walks every reachable view in order.
  | { t: "cycle" }
  // A tile was clicked (a PIP corner, or a grid cell): focus it.
  | { t: "select"; id: DeviceId };

// Apply one input. Every rule reads the RESOLVED view, so a press always
// continues from what's on screen rather than from a stored intent that presence
// has overtaken. Returns the same object identity when nothing changes, so the
// adapter can skip a re-render — which is what makes a press on a slot nobody
// has joined a visible no-op (the legend still flashes, showing that slot dimmed).
export function viewReduce(
  view: ViewState,
  event: ViewEvent,
  present: readonly DeviceId[],
  live: readonly DeviceId[] = present,
): ViewState {
  // Nothing on the stage: nothing to change, and nothing to overwrite the
  // restored intent with.
  if (present.length === 0) return view;
  const cur = resolveView(view, present, live);
  switch (event.t) {
    case "press-device": {
      if (!present.includes(event.id)) return view;
      // From the wide view any color press starts that device's cycle at Only —
      // including the remembered focus, which is how grid wraps round to Only.
      if (cur.mode === "grid") return { mode: "only", focus: event.id };
      // A different device: take over the focus but keep the stage, so Only↔Only
      // and PIP↔PIP when flipping between devices.
      if (cur.focus !== event.id) return { ...cur, focus: event.id };
      const stages = stagesFor(present);
      const i = stages.indexOf(cur.mode);
      return { mode: stages[(i + 1) % stages.length]!, focus: event.id };
    }
    case "cycle": {
      const views = cycleViews(present);
      // resolveView only ever yields a view cycleViews emits, so this is never -1.
      const i = views.findIndex((v) => v.mode === cur.mode && v.focus === cur.focus);
      return views[(i + 1) % views.length]!;
    }
    case "select": {
      if (!present.includes(event.id)) return view;
      // Clicking a grid cell promotes it to Only — the same "start the cycle"
      // rule as a color press.
      if (cur.mode === "grid") return { mode: "only", focus: event.id };
      // The full-bleed pane is already what you're looking at.
      if (cur.focus === event.id) return view;
      // A corner thumbnail swaps focus and stays in PIP.
      return { ...cur, focus: event.id };
    }
  }
}

// Every view reachable by the cycle button, in order: the wide view first, then
// each present device's stages grouped together. With two devices that's five
// entries, matching the old five layouts.
export function cycleViews(present: readonly DeviceId[]): ViewState[] {
  const out: ViewState[] = [{ mode: "grid", focus: present[0] ?? "device-a" }];
  const stages = stagesFor(present).filter((mode) => mode !== "grid");
  for (const id of present) for (const mode of stages) out.push({ mode, focus: id });
  return out;
}

export function cycleIndex(
  view: ViewState,
  present: readonly DeviceId[],
  live: readonly DeviceId[] = present,
): number {
  const cur = resolveView(view, present, live);
  return cycleViews(present).findIndex((v) => v.mode === cur.mode && v.focus === cur.focus);
}

// ── Tiles ───────────────────────────────────────────────────────────────────

export type TileKey = DeviceId | "join";

// Geometry in percentages of the stage. The stage is the full viewport, so a tile
// whose width% equals its height% has the stage's own aspect ratio — which is why
// the corner thumbnails below are square in percent terms.
export interface Tile {
  key: TileKey;
  top: number;
  left: number;
  width: number;
  height: number;
  // `main` is a full-bleed focused device, `cell` a grid pane, `corner` a PIP
  // thumbnail, `card` the small docked join prompt. Drives styling only.
  kind: "main" | "cell" | "corner" | "card";
  z: number;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Arrange k equal panes on a 16:9 stage. Three is the only awkward count: two
// across the top and one centered below beats three thin columns for screen
// content, and it's also exactly what a 2×2 looks like with its last cell empty.
function gridCells(k: number): Rect[] {
  if (k <= 1) return [{ top: 0, left: 0, width: 100, height: 100 }];
  if (k === 2) {
    return [
      { top: 0, left: 0, width: 50, height: 100 },
      { top: 0, left: 50, width: 50, height: 100 },
    ];
  }
  const quad: Rect[] = [
    { top: 0, left: 0, width: 50, height: 50 },
    { top: 0, left: 50, width: 50, height: 50 },
    { top: 50, left: 0, width: 50, height: 50 },
    { top: 50, left: 50, width: 50, height: 50 },
  ];
  if (k === 3) return [quad[0]!, quad[1]!, { top: 50, left: 25, width: 50, height: 50 }];
  return quad;
}

// Corner thumbnails: a bottom-right row of the non-focused devices, sized down as
// more of them appear so the strip never eats the focused picture.
const CORNER_SIZE = [28, 21, 17]; // by count: 1, 2, 3 others
const CORNER_GAP = 1.5;
const CORNER_RIGHT = 2;
// Enough clearance for the controls bar, which is centered along the bottom and
// overlays everything: with three thumbnails the strip reaches the middle of the
// screen, so a tighter margin buries their name tags behind the buttons whenever
// the bar is up (any keypress shows it for four seconds).
const CORNER_BOTTOM = 7;

function cornerTiles(others: readonly DeviceId[]): Tile[] {
  const size = CORNER_SIZE[others.length - 1] ?? CORNER_SIZE[CORNER_SIZE.length - 1]!;
  const span = others.length * size + (others.length - 1) * CORNER_GAP;
  const left0 = 100 - CORNER_RIGHT - span;
  return others.map((id, i) => ({
    key: id,
    top: 100 - CORNER_BOTTOM - size,
    left: left0 + i * (size + CORNER_GAP),
    width: size,
    height: size,
    kind: "corner" as const,
    z: 10,
  }));
}

// The docked join card, used when the invitation can't be a grid cell (see
// computeTiles). Same corner as a PIP thumbnail but sized to keep a QR scannable.
const JOIN_CARD_SIZE = 22;

export interface TileInput {
  view: ViewState;
  present: readonly DeviceId[];
  live?: readonly DeviceId[];
  // Whether joining exists as a concept: rooms only do on a configured
  // (multi-tenant) hub. Whether there is actually a free slot to invite someone
  // into is decided here, not by the caller — it's a fact about the layout.
  canJoin: boolean;
}

// The single source of on-screen geometry. Any slot whose id is absent from the
// result is not on screen — the adapter hides it (and it keeps streaming at a
// thumbnail resolution so bringing it back is instant, never a black frame).
//
// The join tile earns a full grid cell only when it fits the grid exactly: one
// device (a 50/50 with the invitation, the two-device look people already know)
// or three (the empty fourth cell of the 2×2). At two devices it docks as a small
// card instead — making it a third equal cell would shrink the most common setup
// from today's full-height halves, which is a real loss for an invitation nobody
// is looking at.
export function computeTiles({ view, present, live, canJoin }: TileInput): Tile[] {
  if (present.length === 0) return [];
  const { mode, focus } = resolveView(view, present, live ?? present);
  const invite = canJoin && present.length < SENDER_IDS.length;

  if (mode === "only") {
    return [{ key: focus, top: 0, left: 0, width: 100, height: 100, kind: "main", z: 1 }];
  }

  if (mode === "pip") {
    const others = present.filter((id) => id !== focus);
    return [
      { key: focus, top: 0, left: 0, width: 100, height: 100, kind: "main", z: 1 },
      ...cornerTiles(others),
    ];
  }

  const joinAsCell = invite && (present.length === 1 || present.length === 3);
  const cells = gridCells(present.length + (joinAsCell ? 1 : 0));
  // A lone pane covers the whole stage, so it is the same object the `only`
  // branch draws — no hairline, no name tag, no pointer.
  const kind = cells.length === 1 ? ("main" as const) : ("cell" as const);
  const tiles: Tile[] = present.map((id, i) => ({
    key: id,
    ...cells[i]!,
    kind,
    z: 1,
  }));
  if (joinAsCell) {
    tiles.push({ key: "join", ...cells[present.length]!, kind: "cell", z: 1 });
  } else if (invite) {
    tiles.push({
      key: "join",
      top: 100 - CORNER_BOTTOM - JOIN_CARD_SIZE,
      left: 100 - CORNER_RIGHT - JOIN_CARD_SIZE,
      width: JOIN_CARD_SIZE,
      height: JOIN_CARD_SIZE,
      kind: "card",
      z: 10,
    });
  }
  return tiles;
}

// ── Legend / labels ─────────────────────────────────────────────────────────

export interface LegendPill {
  id: DeviceId;
  present: boolean;
  active: boolean;
  // What one more press of this key does, shown on the active pill so the cycle
  // documents itself rather than needing to be remembered.
  next: string | null;
}

const STAGE_LABEL: Record<ViewMode, string> = {
  only: "Only",
  pip: "Corners",
  grid: "All screens",
};

export function viewLabel(
  view: ViewState,
  present: readonly DeviceId[],
  live: readonly DeviceId[] = present,
): string {
  const { mode, focus } = resolveView(view, present, live);
  if (mode === "grid") return STAGE_LABEL.grid;
  const name = deviceLabel(focus);
  return mode === "only" ? `${name} only` : `${name} + corners`;
}

export function legendFor(
  view: ViewState,
  present: readonly DeviceId[],
  live: readonly DeviceId[] = present,
): LegendPill[] {
  const { mode, focus } = resolveView(view, present, live);
  const stages = stagesFor(present);
  return SENDER_IDS.map((id) => {
    const here = present.includes(id);
    const active = here && mode !== "grid" && focus === id;
    // Only the lit pill advertises its next step. Tagging every pill with one in
    // the wide view would just be four identical hints for the obvious thing
    // (a color shows that screen); the chip above already names the current view.
    const next = active ? STAGE_LABEL[stages[(stages.indexOf(mode) + 1) % stages.length]!] : null;
    return { id, present: here, active, next };
  });
}

// ── Persistence ─────────────────────────────────────────────────────────────
// Stored as "mode:device-id" so a hand-edited or stale value simply fails to
// parse and falls back, rather than half-applying.

const MODES: readonly ViewMode[] = ["only", "pip", "grid"];

export function serializeView(view: ViewState): string {
  return `${view.mode}:${view.focus}`;
}

export function parseView(raw: string | null | undefined): ViewState | null {
  if (!raw) return null;
  const [mode, focus] = raw.split(":");
  if (!MODES.includes(mode as ViewMode)) return null;
  if (!isDeviceId(focus)) return null;
  return { mode: mode as ViewMode, focus };
}

// Read the pre-4-device "layout" key so an existing TV keeps the view it was left
// on instead of snapping back to the grid on first load.
const LEGACY_VIEWS: Record<string, ViewState> = {
  "side-by-side": { mode: "grid", focus: "device-a" },
  "pip-a": { mode: "pip", focus: "device-a" },
  "pip-b": { mode: "pip", focus: "device-b" },
  "solo-a": { mode: "only", focus: "device-a" },
  "solo-b": { mode: "only", focus: "device-b" },
};

export function migrateLegacyView(layout: string | null | undefined): ViewState | null {
  return layout ? (LEGACY_VIEWS[layout] ?? null) : null;
}
