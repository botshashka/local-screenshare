// Pure receiver view model: which device is focused, in what style, and where
// every tile sits on the stage. The adapter in receiver.ts owns the DOM and
// applies what this returns — no layout decision is made there.
//
// WHY THIS IS DATA, NOT CSS. With two devices the five arrangements
// (side-by-side / pip-a / pip-b / solo-a / solo-b) fit in five hand-written CSS
// rulesets keyed off a body class. With four they don't: 4 focus targets × 3
// stages × 5 grid shapes is a combinatorial explosion no one can keep correct by
// hand. So geometry is computed here as percentages of the stage and applied
// inline, which also makes every arrangement unit-testable instead of
// eyeball-testable.
//
// THE REMOTE MODEL — one rule, no extra buttons. The TV's four color keys own the
// four sender slots (red/green/yellow/blue = A/B/C/D). Pressing a color you are
// not on focuses that device *keeping the current stage*; pressing the color you
// are already on advances that device's cycle:
//
//     Only ──▶ PIP ──▶ All (grid) ──▶ Only ──▶ …
//
// This is the two-device behavior generalized rather than a new model: switching
// devices already carried the corner preference over, and blue's old show/hide-
// corner toggle is now the middle step of the cycle instead of its own button —
// which is what frees blue to be Device D.
//
// STORED INTENT vs EFFECTIVE VIEW. What the user last chose is kept verbatim;
// what's actually on screen is derived from it and the current presence by
// `resolveView`, at read time. Nothing ever rewrites the stored view in response
// to a presence change — which matters because presence is constantly in flux:
// a receiver reload replays every sender as a separate message, so rewriting on
// each one would let the first arrival (not the saved device) wipe the saved
// view before the saved device had even announced itself. Resolving instead
// means the view snaps back the moment its device reappears.
//
// Two things get resolved away: a focus on a device that isn't here (fall back
// to the wide view — the grid is the only honest thing to show when the subject
// is gone), and PIP with nobody to put in the corner (renders as Only, and comes
// back by itself when a second device joins).

import {
  SENDER_IDS,
  deviceColor,
  deviceLabel,
  type DeviceColor,
  type DeviceId,
} from "./rtc-utils.js";

export type ViewMode = "only" | "pip" | "grid";

export interface ViewState {
  mode: ViewMode;
  // The device the color cycle is "on". Retained through grid so that pressing
  // its color again wraps back to Only — the last step of the cycle.
  focus: DeviceId;
}

export const initialView: ViewState = { mode: "grid", focus: "device-a" };

// What the stored view actually means right now. Returns the same object when
// the stored view is already what's on screen, so callers can compare by identity.
export function resolveView(view: ViewState, present: readonly DeviceId[]): ViewState {
  // Nothing to lay out yet: keep the restored intent intact so a saved
  // "Device A only" still applies the moment Device A arrives.
  if (present.length === 0) return view;
  if (!present.includes(view.focus)) return { mode: "grid", focus: present[0]! };
  if (view.mode === "pip" && present.length < 2) return { mode: "only", focus: view.focus };
  return view;
}

// The cycle a single device's color key walks, shortest-first. `grid` is always
// last so one more press of the lit color always lands back on the wide view.
function stagesFor(present: readonly DeviceId[]): ViewMode[] {
  return present.length < 2 ? ["only", "grid"] : ["only", "pip", "grid"];
}

export type ViewEvent =
  // A TV color key (or its 1-4 / r-g-y-b keyboard equivalent): index into SENDER_IDS.
  | { t: "press-color"; index: number }
  // The on-screen layout button / L / Space — walks every reachable view in order.
  | { t: "cycle" }
  // A tile was clicked (a PIP corner, or a grid cell): focus it.
  | { t: "select"; id: DeviceId };

// Apply one input. `present` is the set of senders the hub says are in the room,
// in slot order. Every rule reads the RESOLVED view, so a press always continues
// from what's on screen rather than from a stored intent that presence has
// overtaken. Returns the same object identity when nothing changes, so the
// adapter can skip a re-render — which is what makes a press on a slot nobody has
// joined a visible no-op (the legend still flashes, showing that slot dimmed).
export function viewReduce(
  view: ViewState,
  event: ViewEvent,
  present: readonly DeviceId[],
): ViewState {
  const cur = resolveView(view, present);
  switch (event.t) {
    case "press-color": {
      const id = SENDER_IDS[event.index];
      if (!id || !present.includes(id)) return view;
      const stages = stagesFor(present);
      // From the wide view any color press starts that device's cycle at Only —
      // including the remembered focus, which is how grid wraps round to Only.
      if (cur.mode === "grid") return { mode: "only", focus: id };
      // A different device: take over the focus but keep the stage, so Only↔Only
      // and PIP↔PIP when flipping between devices.
      if (cur.focus !== id) return { ...cur, focus: id };
      const i = stages.indexOf(cur.mode);
      return { mode: stages[(i + 1) % stages.length]!, focus: id };
    }
    case "cycle": {
      const views = cycleViews(present);
      const i = views.findIndex((v) => v.mode === cur.mode && v.focus === cur.focus);
      // Not in the list: restart at the front rather than guessing — findIndex's
      // -1 would otherwise wrap to the last entry.
      return views[(i + 1) % views.length] ?? view;
    }
    case "select": {
      if (!present.includes(event.id)) return view;
      // Clicking a corner thumbnail swaps focus and stays in PIP; clicking a grid
      // cell promotes it to Only — the same "start the cycle" rule as a color press.
      if (cur.mode === "grid") return { mode: "only", focus: event.id };
      return { ...cur, focus: event.id };
    }
  }
}

// Every view reachable by the cycle button, in order: the wide view first, then
// each present device's stages grouped together. With two devices that's five
// entries, matching the old five layouts.
export function cycleViews(present: readonly DeviceId[]): ViewState[] {
  const focus = present[0] ?? "device-a";
  if (present.length === 0) return [{ mode: "grid", focus }];
  const out: ViewState[] = [{ mode: "grid", focus }];
  for (const id of present) {
    out.push({ mode: "only", focus: id });
    if (present.length >= 2) out.push({ mode: "pip", focus: id });
  }
  return out;
}

export function cycleIndex(view: ViewState, present: readonly DeviceId[]): number {
  const cur = resolveView(view, present);
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
export function computeTiles({ view, present, canJoin }: TileInput): Tile[] {
  if (present.length === 0) return [];
  const { mode, focus } = resolveView(view, present);
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
  const tiles: Tile[] = present.map((id, i) => ({
    key: id,
    ...cells[i]!,
    kind: "cell" as const,
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
  color: DeviceColor;
  id: DeviceId;
  label: string;
  letter: string;
  present: boolean;
  active: boolean;
  // What one more press of this key does, shown on the active pill so the cycle
  // documents itself rather than needing to be remembered.
  next: string | null;
}

const STAGE_LABEL: Record<ViewMode, string> = { only: "Only", pip: "PIP", grid: "All" };

export function viewLabel(view: ViewState, present: readonly DeviceId[]): string {
  const { mode, focus } = resolveView(view, present);
  if (mode === "grid") return "All screens";
  const name = deviceLabel(focus);
  return mode === "only" ? `${name} only` : `${name} + corners`;
}

export function legendFor(view: ViewState, present: readonly DeviceId[]): LegendPill[] {
  const { mode, focus } = resolveView(view, present);
  const stages = stagesFor(present);
  return SENDER_IDS.map((id, i) => {
    const here = present.includes(id);
    const active = here && mode !== "grid" && focus === id;
    // Only the lit pill advertises its next step. Tagging every pill with one in
    // the wide view would just be four identical hints for the obvious thing
    // (a color shows that screen); the chip above already names the current view.
    const next = active ? STAGE_LABEL[stages[(stages.indexOf(mode) + 1) % stages.length]!] : null;
    return {
      color: deviceColor(id),
      id,
      label: deviceLabel(id),
      letter: String.fromCharCode(65 + i),
      present: here,
      active,
      next,
    };
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
  if (!(SENDER_IDS as readonly string[]).includes(focus ?? "")) return null;
  return { mode: mode as ViewMode, focus: focus as DeviceId };
}

// Read the pre-4-device "layout" key so an existing TV keeps the view it was left
// on instead of snapping back to the grid on first load. The old `showSecondary`
// preference needs no migration: it was only ever a way to remember pip-vs-solo,
// which the layout name already encodes.
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
