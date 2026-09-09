import {
  STUN,
  SENDER_IDS,
  signalingHost,
  signalingUrl,
  generateRoomCode,
  coerceRoomCode,
  persistRoomInUrl,
  startHeartbeat,
  trackConnectionLiveness,
  deviceColor,
  deviceLabel,
  deviceLetter,
  isDeviceId,
  type DeviceColor,
  type DeviceId,
  type ResTarget,
  type ReceiverInMsg,
} from "./rtc-utils.js";
import {
  initialView,
  viewReduce,
  computeTiles,
  cycleViews,
  cycleIndex,
  legendFor,
  viewLabel,
  serializeView,
  parseView,
  migrateLegacyView,
  type ViewState,
  type ViewEvent,
} from "./layout.js";
import {
  receiverReduce,
  initialReceiverState,
  type ReceiverState,
  type ReceiverEvent,
  type ReceiverAction,
} from "./receiver-session.js";
import {
  receiverControllerReduce,
  wantRoomCard,
  roomCardEffect,
  joinedIds,
  liveIds,
  staleJoins,
  initialReceiverControllerState,
  type ReceiverControllerState,
  type ReceiverControllerEvent,
  type ReceiverControllerAction,
} from "./receiver-controller.js";

// Vendored QR encoder (public/vendor/qrcode.js), loaded as a classic script
// before this module so it's a global. Typed minimally for the bits we use.
declare const qrcode: (
  typeNumber: number,
  errorCorrectionLevel: string,
) => {
  addData(data: string): void;
  make(): void;
  createDataURL(cellSize?: number, margin?: number): string;
};

// A slot that isn't in the current arrangement is display:none and measures
// 0×0. Keep streaming it at a low-res thumbnail so bringing it back is instant
// rather than a black frame.
const MIN_TARGET: ResTarget = { w: 426, h: 240 };
// .tile has a 0.25s CSS transition; wait it out before measuring final geometry.
const LAYOUT_SETTLE_MS = 300;

const layoutBtn = document.getElementById("layoutBtn") as HTMLButtonElement;
const layoutLabel = document.getElementById("layoutLabel") as HTMLElement;
const layoutDots = document.getElementById("layoutDots") as HTMLElement;
const hint = document.getElementById("hint") as HTMLElement;
const legend = document.getElementById("legend") as HTMLElement;
const legendView = document.getElementById("legendView") as HTMLElement;
const stage = document.getElementById("stage") as HTMLElement;
const joinTile = document.getElementById("joinTile") as HTMLElement;

// ── Slots ───────────────────────────────────────────────────────────────────
// Built from the shared SENDER_IDS rather than written out in the HTML, so the
// panes, the color keys, and the slots the hub will hand out can never disagree
// about how many devices exist.
const slots: Record<string, HTMLElement> = {};
const videos: Record<string, HTMLVideoElement> = {};
for (const id of SENDER_IDS) {
  const slot = document.createElement("div");
  slot.className = "tile slot disconnected";
  slot.id = `slot-${id}`;
  slot.hidden = true;
  // Its remote-button color, used by the name tag's dot.
  slot.style.setProperty("--accent", `var(--c-${deviceColor(id)})`);

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const ring = document.createElement("div");
  ring.className = "ring";
  const waiting = document.createElement("span");
  waiting.textContent = `Waiting for ${deviceLabel(id)}…`;
  overlay.append(ring, waiting);

  const tag = document.createElement("div");
  tag.className = "tag";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = deviceLetter(id);
  tag.append(dot, document.createTextNode(deviceLabel(id)));

  slot.append(video, overlay, tag);
  // Clicking a pane that shares the screen promotes it. Clicking the full-bleed
  // one is a no-op, which viewReduce decides — not this handler.
  slot.addEventListener("click", () => dispatchView({ t: "select", id }));
  stage?.appendChild(slot);
  slots[id] = slot;
  videos[id] = video;
}

// ── Legend pills ────────────────────────────────────────────────────────────
const legendPills = SENDER_IDS.map((id) => {
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.style.setProperty("--accent", `var(--c-${deviceColor(id)})`);
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = deviceLetter(id);
  const label = document.createElement("span");
  label.textContent = deviceLabel(id);
  const next = document.createElement("span");
  next.className = "next";
  pill.append(dot, label, next);
  legend?.appendChild(pill);
  return { pill, next };
});

let legendTimer: ReturnType<typeof setTimeout>;
function showLegend(): void {
  if (!legend) return;
  legend.classList.add("show");
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => legend.classList.remove("show"), 4000);
}

// ── View state ──────────────────────────────────────────────────────────────
// Two different questions, two different sets, both owned by the controller
// reducer (see joinedIds / liveIds):
//   joined — the hub says the sender is in the room. Decides which panes EXIST:
//     a pane has to appear the moment a device joins, so its "waiting" state is
//     visible, and has to keep its place through a transient ICE flap rather
//     than making the whole stage reflow around it.
//   live   — the sender is actually sending frames. Decides which panes may hold
//     the FOCUS, because senders register on page load: a device that only
//     opened the page must not bury a picture that is playing.
function joined(): DeviceId[] {
  return joinedIds(rxCtl);
}
function live(): DeviceId[] {
  return liveIds(rxCtl);
}

// Restore the saved view, falling back through the pre-4-device "layout" key so
// an existing TV keeps the arrangement it was left on.
function restoreView(): ViewState {
  return (
    parseView(localStorage.getItem("view")) ??
    migrateLegacyView(localStorage.getItem("layout")) ??
    initialView
  );
}
// The user's stored INTENT. What's actually on screen is derived from it and the
// current presence inside layout.ts (resolveView) at every read — nothing here
// rewrites it when a device comes or goes, so a reload can't lose the saved view
// to whichever sender happens to re-announce itself first.
let view: ViewState = restoreView();

// Single render path for everything the view decides: tile geometry, the
// controls-bar label/dots, and the legend. Slots absent from the computed tiles
// are hidden — they keep decoding at MIN_TARGET so coming back is instant.
function renderView(): void {
  const ids = joined();
  const shown = live();
  const tiles = computeTiles({ view, present: ids, live: shown, canJoin: hubConfigured });
  const placed = new Set<string>();
  for (const tile of tiles) {
    const el = tile.key === "join" ? joinTile : slots[tile.key];
    if (!el) continue;
    placed.add(tile.key);
    el.hidden = false;
    el.style.top = `${tile.top}%`;
    el.style.left = `${tile.left}%`;
    el.style.width = `${tile.width}%`;
    el.style.height = `${tile.height}%`;
    el.style.zIndex = String(tile.z);
    el.classList.remove("kind-main", "kind-cell", "kind-corner");
    el.classList.add(`kind-${tile.kind}`);
  }
  for (const [id, el] of Object.entries(slots)) if (!placed.has(id)) el.hidden = true;
  if (joinTile && !placed.has("join")) joinTile.hidden = true;

  if (layoutLabel) layoutLabel.textContent = viewLabel(view, ids, shown);
  if (layoutDots) {
    const total = cycleViews(ids).length;
    while (layoutDots.childElementCount > total) layoutDots.lastElementChild?.remove();
    while (layoutDots.childElementCount < total) {
      layoutDots.appendChild(document.createElement("span"));
    }
    const active = cycleIndex(view, ids, shown);
    layoutDots
      .querySelectorAll("span")
      .forEach((el, i) => el.classList.toggle("active", i === active));
  }
  if (legendView) legendView.textContent = viewLabel(view, ids, shown);
  legendFor(view, ids, shown).forEach((info, i) => {
    const pill = legendPills[i];
    if (!pill) return;
    pill.pill.classList.toggle("active", info.active);
    pill.pill.classList.toggle("absent", !info.present);
    pill.next.textContent = info.next ? `→ ${info.next}` : "";
  });

  scheduleResHints();
}

function saveView(): void {
  localStorage.setItem("view", serializeView(view));
}

function dispatchView(event: ViewEvent): void {
  const next = viewReduce(view, event, joined(), live());
  if (next === view) return;
  view = next;
  saveView();
  renderView();
}

const pcs: Record<string, RTCPeerConnection> = {};
const retryTimers: Record<string, ReturnType<typeof setTimeout>> = {};
// Per-sender post-connected "reveal anyway" fallback timers.
const revealFallbackTimers: Record<string, ReturnType<typeof setTimeout>> = {};
// Per-sender connection-liveness watchers (transient-flap vs. real-loss arbiter).
const livenessWatchers: Record<string, ReturnType<typeof trackConnectionLiveness>> = {};
// How long after a real loss before asking the sender to re-offer.
const RETRY_MS = 2000;

// The pure per-slot media controller (srcObject lifecycle, reveal latch,
// liveness/retry, room-card visibility). The adapter feeds it gen-tagged events
// and applies its actions; see dispatchRx / applyRxCtl below.
let rxCtl: ReceiverControllerState = initialReceiverControllerState;

// Autoplay policy. We want sound the instant a stream arrives — no tap. So we
// play OPTIMISTICALLY UNMUTED first: on platforms that permit autoplay-with-
// sound (high media-engagement, installed/kiosk apps, smart-TV browsers, or
// Chrome launched with --autoplay-policy=no-user-gesture-required) audio just
// works. Only if the browser actually refuses an unmuted play() (NotAllowedError
// — the TV-reload gray-screen cause) do we fall back to MUTED playback (always
// allowed, so the slot is never gray) and unmute on the first real user gesture
// (remote keypress / click / touch). mousemove is NOT a gesture for autoplay.
let userInteracted = false;
// Latched once an unmuted play() is refused this load, so subsequent slots go
// straight to muted instead of each re-triggering a refusal. Cleared by a gesture.
let soundBlocked = false;
const GESTURES = ["pointerdown", "keydown", "touchstart"] as const;
function onFirstGesture(): void {
  if (userInteracted) return;
  userInteracted = true;
  soundBlocked = false;
  for (const evt of GESTURES) document.removeEventListener(evt, onFirstGesture);
  for (const v of Object.values(videos)) {
    v.muted = false;
    void v.play().catch(() => {});
  }
  // This gesture is also our first chance to satisfy the Fullscreen API's
  // gesture requirement — enter now (unless the user opted out) so the display
  // fills the panel without a separate tap. Defined below; hoisted.
  autoEnterFullscreen();
}
for (const evt of GESTURES) document.addEventListener(evt, onFirstGesture);

// Play a slot's video preferring sound. Tries unmuted; if the autoplay policy
// refuses, downgrades that element to muted (so video still shows) and latches
// soundBlocked so onFirstGesture knows to unmute on the next interaction.
function playWithSound(video: HTMLVideoElement): void {
  if (soundBlocked && !userInteracted) {
    // Already know sound is blocked this load — don't re-trigger a refusal.
    video.muted = true;
    void video.play().catch(() => {});
    return;
  }
  video.muted = false;
  video.play().catch(() => {
    soundBlocked = true;
    video.muted = true;
    void video.play().catch(() => {});
  });
}

// ── Room ─────────────────────────────────────────────────────────────────────
// Rooms exist only to isolate tenants on a shared public hub. A co-located
// `server.ts` is a single global hub with nothing to isolate, so the whole room
// feature (code + QR panel here, join code on the sender) is active only when a
// hub is configured. With none, this stays empty and the panel is hidden — the
// local `pnpm start` flow is unchanged.
const params = new URLSearchParams(location.search);
const hubConfigured = signalingHost() !== null;
const roomPanel = document.getElementById("roomPanel") as HTMLElement | null;

// The TV owns the room: a code from ?room= (or a previously generated one in
// localStorage) is reused so reloads keep the same room and senders stay paired;
// otherwise we mint a fresh unguessable code. It's persisted and reflected into
// the URL, then shown on screen as a number + QR for senders to scan/open.
let room = "";
if (hubConfigured) {
  room =
    coerceRoomCode(params.get("room")) ??
    coerceRoomCode(localStorage.getItem("room")) ??
    generateRoomCode();
  localStorage.setItem("room", room);
  persistRoomInUrl(room);
  renderRoomPanel();
}

// The sender URL a join QR/link points at: sender.html?room=CODE, carrying an
// explicit ?hub= through so a join opened from a local-dev receiver targets the
// same hub the receiver is using.
function senderUrl(code: string): string {
  const url = new URL("sender.html", location.href);
  url.searchParams.set("room", code);
  const hub = params.get("hub");
  if (hub) url.searchParams.set("hub", hub);
  return url.toString();
}

function renderRoomPanel(): void {
  const codeEl = document.getElementById("roomCode");
  if (codeEl) codeEl.textContent = room;
  // What to type manually: just the bare domain (the root lands on this screen),
  // not the full sender URL — the QR carries the full link for scanning.
  const domainEl = document.getElementById("roomDomain");
  if (domainEl) domainEl.textContent = location.host;
  let qrDataUrl = "";
  if (typeof qrcode === "function") {
    // A QR encode can throw (e.g. capacity overflow on a very long ?hub= URL).
    // Degrade to the text code rather than letting it abort module init — the
    // signaling connectWS() below must still run.
    try {
      const qr = qrcode(0, "M");
      qr.addData(senderUrl(room));
      qr.make();
      qrDataUrl = qr.createDataURL(6, 8);
    } catch {
      qrDataUrl = "";
    }
  }
  const img = document.getElementById("roomQr") as HTMLImageElement | null;
  if (img && qrDataUrl) img.src = qrDataUrl;

  // Mirror the same QR / domain / code into the on-stage join tile, so the next
  // person can still scan in after the big room card has gone away.
  const tileQr = joinTile?.querySelector<HTMLImageElement>(".join-qr");
  if (tileQr && qrDataUrl) tileQr.src = qrDataUrl;
  const tileDomain = joinTile?.querySelector(".join-domain");
  if (tileDomain) tileDomain.textContent = location.host;
  const tileCode = joinTile?.querySelector(".join-code");
  if (tileCode) tileCode.textContent = room;
  // Join form: become a sender to *another* screen by typing the code shown on
  // it. Opening the root on a phone mints a throwaway room for this device; this
  // navigates away to the real session (abandoning that throwaway room, which
  // empties the moment this socket closes). Guard against typing this very
  // screen's own code — the confusion case — which would just pair the device
  // with its own throwaway room.
  const joinForm = document.getElementById("joinForm") as HTMLFormElement | null;
  const joinInput = document.getElementById("roomJoinInput") as HTMLInputElement | null;
  const joinErr = document.getElementById("roomJoinError");
  if (joinForm && joinInput) {
    joinForm.onsubmit = (e) => {
      e.preventDefault();
      const code = coerceRoomCode(joinInput.value);
      if (!code) {
        if (joinErr) joinErr.textContent = "Enter the 4-character code shown on the other screen.";
        return;
      }
      if (code === room) {
        if (joinErr)
          joinErr.textContent =
            "That’s this screen’s own code — enter the code from the screen you want to share to.";
        return;
      }
      location.href = senderUrl(code);
    };
  }
}

// Show the join panel only while nothing is on screen — once any device is
// streaming it gets out of the way, and it returns when all disconnect. With no
// hub configured (local single-hub server) there are no rooms, so it stays gone.
//
// Revealing the card the instant nothing is connected flashes it during the gap
// between this view loading (or a sender reloading) and the stream coming up — a
// sender already in the room re-pairs within ~a second. So defer *showing* the
// card by a short grace window: if a device connects first, the card never
// appears. Hiding it once connected is always immediate.
const ROOM_PANEL_GRACE_MS = 1500;
let roomPanelGraceTimer: ReturnType<typeof setTimeout> | undefined;

// How long after a peer connection reports `connected` to wait for a first
// decoded frame before revealing the slot anyway (see the fallback in createPC).
const REVEAL_FALLBACK_MS = 2500;

// `joining` hides all TV-viewing chrome (#tvView) so the card sits on a clean
// full screen, not over empty "waiting" placeholders; the card itself toggles in
// tandem. The page's first paint is already this state (body `joining`, card
// `hidden`), so the grace wait below shows nothing new.
function showRoomPanel(show: boolean): void {
  if (!roomPanel) return;
  roomPanel.classList.toggle("hidden", !show);
  document.body.classList.toggle("joining", show);
}

// Derived, EDGE-triggered room-card visibility. `wantRoomCard` is a pure function
// of the controller's per-slot `revealed` latches; we act only when the desired
// state CHANGES, never re-arming the grace timer on an unchanged level (doing that
// on every event would reset the timer forever and the card would never appear).
// Hiding is immediate; showing waits out the grace window (re-checked on fire) so
// a brief (re)connect can't flash the card. Because `revealed` persists across a
// rebuild, the card stays hidden through a re-share/reconnect.
let prevWantCard: boolean | null = null;
function applyRoomPanel(): void {
  if (!roomPanel) return;
  const want = wantRoomCard(rxCtl, hubConfigured);
  const effect = roomCardEffect(prevWantCard, want);
  if (effect === "none") return;
  prevWantCard = want;
  clearTimeout(roomPanelGraceTimer);
  roomPanelGraceTimer = undefined;
  if (effect === "hide-now") {
    showRoomPanel(false);
    return;
  }
  roomPanelGraceTimer = setTimeout(() => {
    roomPanelGraceTimer = undefined;
    if (wantRoomCard(rxCtl, hubConfigured)) showRoomPanel(true);
  }, ROOM_PANEL_GRACE_MS);
}
applyRoomPanel();

let ws: WebSocket;

// Measure a slot's on-screen size in device pixels — the resolution the sender
// should encode to. devicePixelRatio maps CSS px → the panel's real pixels (so
// a 4K TV asks for 4K-worth, a 1080p TV for 1080p-worth, automatically).
function targetForSlot(slot: HTMLElement): ResTarget {
  const dpr = window.devicePixelRatio || 1;
  const rect = slot.getBoundingClientRect();
  return {
    w: Math.max(MIN_TARGET.w, Math.round(rect.width * dpr)),
    h: Math.max(MIN_TARGET.h, Math.round(rect.height * dpr)),
  };
}

// Last target each sender was told, so an unchanged one isn't re-sent. Every
// hint that lands costs the sender a getParameters/setParameters round on its
// encoder, and a changed scaleResolutionDownBy forces a reconfiguration and a
// keyframe — so re-stating a size it already has is not free. Most renders move
// one or two panes, and a slot nobody has joined has no listener at all.
const lastHint: Record<string, ResTarget> = {};

// A fresh socket means the senders behind it may be fresh too: forget what we
// think they know rather than staying silent on a stale match.
function resetResHints(): void {
  for (const id of Object.keys(lastHint)) delete lastHint[id];
}

function sendResHints(onlyFor?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const to of joined()) {
    if (onlyFor && to !== onlyFor) continue;
    const slot = slots[to];
    if (!slot) continue;
    const target = targetForSlot(slot);
    const prev = lastHint[to];
    if (prev && prev.w === target.w && prev.h === target.h) continue;
    lastHint[to] = target;
    ws.send(JSON.stringify({ type: "res-hint", to, from: "receiver", target }));
  }
}

// Layout changes and window resizes animate/resize the slots, so measure once
// the geometry has settled rather than mid-transition.
let resHintTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleResHints(): void {
  clearTimeout(resHintTimer);
  resHintTimer = setTimeout(() => sendResHints(), LAYOUT_SETTLE_MS);
}

// The TV panel is fixed, but a resized browser window (dev/desktop) changes slot
// sizes — re-measure when it settles.
window.addEventListener("resize", scheduleResHints);

// First paint of the stage. Nobody has joined yet, so this lays out an empty
// stage behind the room card. It has to come after scheduleResHints' timer
// binding, which renderView reaches into.
renderView();

// DOM handlers for the controller's reveal-slot / mark-disconnected actions. The
// srcObject INVARIANT is now enforced by the controller, not by a comment here:
// the source is nulled in exactly ONE place (the `null-srcobject` action, emitted
// only by peer-disconnected) and reset only on a rebuild (`reset-srcobject`, emitted
// only by offer-arrived). A transient flap never reaches either — the controller
// keeps the last frame (it freezes, then unfreezes on heal). The provenance tests
// in receiver-controller.test.ts prove this; re-verify the browser semantic itself
// in real Chrome via the DevTools offline toggle.
function markDisconnected(id: string): void {
  const slot = slots[id];
  if (slot) {
    slot.classList.remove("connected");
    slot.classList.add("disconnected");
  }
}

function revealSlot(id: string): void {
  const slot = slots[id];
  if (!slot) return;
  slot.classList.remove("disconnected");
  slot.classList.add("connected");
}

layoutBtn?.addEventListener("click", () => dispatchView({ t: "cycle" }));

// ── Fullscreen ──────────────────────────────────────────────────────────────
// The receiver is a second-screen/TV display, so filling the panel (hiding the
// browser's chrome) is almost always what's wanted. Toggle via the button, the F
// key, or — since requestFullscreen needs a user gesture and can't fire on load —
// automatically on the FIRST gesture of the session (see onFirstGesture). Leaving
// fullscreen by any means (button, F, Esc) latches an opt-out so we stop
// auto-entering on later loads; re-entering manually clears it.
const fullscreenBtn = document.getElementById("fullscreenBtn");
type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const fsRoot = document.documentElement as FsEl;
const fullscreenSupported = !!(fsRoot.requestFullscreen ?? fsRoot.webkitRequestFullscreen);

function inFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}
function enterFullscreen(): void {
  const req = fsRoot.requestFullscreen ?? fsRoot.webkitRequestFullscreen;
  if (!req) return;
  try {
    const r = req.call(fsRoot) as unknown;
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
  } catch {
    // no gesture / not permitted — the button and F key remain available
  }
}
function exitFullscreen(): void {
  const d = document as FsDoc;
  const exit = d.exitFullscreen ?? d.webkitExitFullscreen;
  if (!exit) return;
  try {
    exit.call(d);
  } catch {
    // already exiting
  }
}
function toggleFullscreen(): void {
  if (inFullscreen()) exitFullscreen();
  else enterFullscreen();
}
// Enter fullscreen unless the user has previously opted out this device.
function autoEnterFullscreen(): void {
  if (!fullscreenSupported || inFullscreen()) return;
  if (localStorage.getItem("fsOptOut") === "1") return;
  enterFullscreen();
}
let wasFullscreen = false;
function syncFullscreenUI(): void {
  const now = inFullscreen();
  document.body.classList.toggle("fullscreen", now);
  // Leaving fullscreen (Esc, the button, F) means the user doesn't want it —
  // remember that so we don't fight them on the next load. Entering clears it.
  if (wasFullscreen && !now) localStorage.setItem("fsOptOut", "1");
  else if (now) localStorage.removeItem("fsOptOut");
  wasFullscreen = now;
}
if (fullscreenBtn) {
  if (!fullscreenSupported) fullscreenBtn.classList.add("unsupported");
  else fullscreenBtn.addEventListener("click", toggleFullscreen);
}
document.addEventListener("fullscreenchange", syncFullscreenUI);
document.addEventListener("webkitfullscreenchange", syncFullscreenUI as EventListener);

// How each remote color announces itself. Keyed BY COLOR, not by position, so it
// can't drift out of step with the color→device mapping in rtc-utils.ts; the
// device a press means is then looked up through that mapping rather than
// re-encoded here. e.key carries "ColorFxName" on modern firmware; keyCode
// 403–406 is the fallback for sets that don't send it, and r/g/y/b are the
// desktop equivalents.
const REMOTE_KEYS: Record<DeviceColor, { key: string; letter: string; code: number }> = {
  red: { key: "ColorF0Red", letter: "r", code: 403 },
  green: { key: "ColorF1Green", letter: "g", code: 404 },
  yellow: { key: "ColorF2Yellow", letter: "y", code: 405 },
  blue: { key: "ColorF3Blue", letter: "b", code: 406 },
};

// Which device a keypress selects: its own color key, or its 1-4 position.
function pressedDevice(e: KeyboardEvent): DeviceId | undefined {
  const letter = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return SENDER_IDS.find((id, i) => {
    const k = REMOTE_KEYS[deviceColor(id)];
    return (
      k.key === e.key || k.letter === letter || k.code === e.keyCode || e.key === String(i + 1)
    );
  });
}

document.addEventListener("keydown", (e) => {
  // While the join popup is up it covers the screen and there's nothing to lay
  // out, so don't claim the remote hotkeys — let keys reach the code input.
  if (roomPanel && !roomPanel.classList.contains("hidden")) return;
  if (e.key === "l" || e.key === "L" || e.key === " ") {
    e.preventDefault();
    dispatchView({ t: "cycle" });
    showLegend();
    return;
  }
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  const id = pressedDevice(e);
  if (id) {
    e.preventDefault();
    dispatchView({ t: "press-device", id });
    // Unconditional, so a press on a slot nobody has joined still flashes the
    // legend with that key dimmed rather than reading as a dead button.
    showLegend();
  }
});

let idleTimer: ReturnType<typeof setTimeout>;
function showControls(): void {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 4000);
}
document.addEventListener("mousemove", showControls);
document.addEventListener("keydown", showControls);
showControls();

setTimeout(() => {
  if (!hint) return;
  hint.classList.add("show");
  setTimeout(() => hint.classList.remove("show"), 3500);
}, 800);

// Build the RTCPeerConnection for a slot and wire its media closures to the
// controller, all tagged with this rebuild's `gen` (the negotiation epoch) so a
// superseded PC's late callbacks are dropped. offer-arrived runs first: it resets
// the <video> to a fresh stream (synchronously, before ontrack can fire) and
// re-bases the slot's generation.
function createPC(senderId: string, gen: number): RTCPeerConnection {
  pcs[senderId]?.close();
  // Stop the prior slot's liveness watcher before it's overwritten below — its
  // identity-guarded onLost would no-op on the superseded PC, but leaving the
  // grace timer running orphans it for the rest of the grace window.
  livenessWatchers[senderId]?.stop();
  dispatchRx({ t: "offer-arrived", id: senderId, gen });

  const pc = new RTCPeerConnection(STUN);
  pcs[senderId] = pc;

  // Arbitrate transient flap vs. real loss; only a real loss escalates.
  const watcher = trackConnectionLiveness({
    onLost: () => {
      if (pcs[senderId] !== pc) return; // superseded by a newer PC
      dispatchRx({ t: "liveness-lost", id: senderId, gen });
    },
  });
  livenessWatchers[senderId] = watcher;

  pc.ontrack = (e) => {
    const video = videos[senderId];
    // Drop a stale PC's track; null srcObject means peer-disconnected tore the
    // slot down (the H3 invariant) — stay torn down.
    if (!video || pcs[senderId] !== pc || !video.srcObject) return;
    const stream = video.srcObject as MediaStream;
    // Swap the track in place (drop the prior same-kind track, add the new one in
    // the same task) so the element never holds an empty stream. On a rebuild this
    // cuts from the frozen last frame straight to the new one — no frameless gap,
    // so the native play-icon placeholder never flashes.
    for (const t of stream.getTracks()) if (t.kind === e.track.kind) stream.removeTrack(t);
    stream.addTrack(e.track);
    // Prefer sound immediately; falls back to muted (never gray) only if the
    // browser refuses unmuted autoplay, then onFirstGesture unmutes on a gesture.
    playWithSound(video);
    const rvfc = (
      video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void }
    ).requestVideoFrameCallback;
    const onFrame = (): void => dispatchRx({ t: "frame-decoded", id: senderId, gen });
    if (rvfc) rvfc.call(video, onFrame);
    else video.addEventListener("playing", onFrame, { once: true });
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate)
      ws.send(JSON.stringify({ type: "ice-candidate", to: senderId, from: "receiver", candidate }));
  };

  pc.onconnectionstatechange = () => {
    // The watcher arbitrates disconnect/failed → its onLost is the real-loss path.
    watcher.update(pc.connectionState);
    const state = pc.connectionState;
    // "closed" is self-induced (our own pc.close()) — don't forward it.
    if (state === "closed") return;
    dispatchRx({ t: "connection-changed", id: senderId, gen, state });
  };

  return pc;
}

// ── Receiver negotiation: pure reducer + thin adapter ───────────────────────
// All offer/answer/ICE decisions live in receiverReduce (pure, unit-tested). This
// adapter just performs the real RTCPeerConnection I/O the reducer asks for and
// feeds the async results back as events. negEpoch[id] records the live PC
// generation per slot so a result from a superseded negotiation (a newer offer
// arrived first) can't be applied to the wrong PC.
let rxSession: ReceiverState = initialReceiverState;
const negEpoch: Record<string, number> = {};

function dispatch(event: ReceiverEvent): void {
  const { state, actions } = receiverReduce(rxSession, event);
  rxSession = state;
  for (const action of actions) applyReceiver(action);
}

function applyReceiver(action: ReceiverAction): void {
  switch (action.t) {
    case "create-pc": {
      negEpoch[action.id] = action.epoch;
      const pc = createPC(action.id, action.epoch);
      // Answerer side: declare the directions we expect so the rebuilt PC lines up
      // with the offer's m-lines (mirrors the original sender-connected setup).
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      break;
    }
    case "set-remote": {
      const pc = pcs[action.id];
      if (!pc || negEpoch[action.id] !== action.epoch) break;
      pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: action.sdp }))
        .then(() => dispatch({ t: "remote-set", id: action.id, epoch: action.epoch }))
        .catch(() =>
          dispatch({ t: "op-failed", id: action.id, epoch: action.epoch, op: "remote" }),
        );
      break;
    }
    case "create-answer": {
      const pc = pcs[action.id];
      if (!pc || negEpoch[action.id] !== action.epoch) break;
      pc.createAnswer()
        .then(async (answer) => {
          await pc.setLocalDescription(answer);
          dispatch({
            t: "answer-created",
            id: action.id,
            epoch: action.epoch,
            sdp: answer.sdp ?? "",
          });
        })
        .catch(() =>
          dispatch({ t: "op-failed", id: action.id, epoch: action.epoch, op: "answer" }),
        );
      break;
    }
    case "send-answer": {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({ type: "answer", to: action.id, from: "receiver", sdp: action.sdp }),
        );
      break;
    }
    case "add-ice": {
      const pc = pcs[action.id];
      if (!pc || negEpoch[action.id] !== action.epoch) break;
      // A single rejected candidate must not tear the session down — swallow it.
      pc.addIceCandidate(new RTCIceCandidate(action.candidate)).catch(() => {});
      break;
    }
  }
}

// ── Receiver media lifecycle: pure controller + thin adapter ─────────────────
// Per-slot srcObject / reveal / liveness / retry policy lives in the controller;
// this adapter performs the real MediaStream / DOM / timer I/O it asks for and
// re-derives the room-card visibility after every step.
function dispatchRx(event: ReceiverControllerEvent): void {
  const { state, actions } = receiverControllerReduce(rxCtl, event);
  rxCtl = state;
  for (const action of actions) applyRxCtl(action);
  // Membership and the reveal latches both feed the layout, so re-derive the
  // stage after every controller event, the same way the room card is.
  renderView();
  applyRoomPanel();
}

function applyRxCtl(action: ReceiverControllerAction): void {
  switch (action.t) {
    case "reset-srcobject": {
      // Rebuild: keep the current stream (its last frame frozen on the now-ended
      // track) so the slot doesn't flash the frameless placeholder; ontrack swaps
      // the fresh track in. Mint a stream only when there's none (first build, or
      // after peer-disconnected nulled it).
      const video = videos[action.id];
      if (video && !video.srcObject) video.srcObject = new MediaStream();
      break;
    }
    case "null-srcobject": {
      // The ONE place the source is nulled — the sender truly left.
      const video = videos[action.id];
      if (video) video.srcObject = null;
      break;
    }
    case "reveal-slot":
      revealSlot(action.id);
      break;
    case "mark-disconnected":
      markDisconnected(action.id);
      break;
    case "schedule-reveal-fallback": {
      clearTimeout(revealFallbackTimers[action.id]);
      const { id, gen } = action;
      revealFallbackTimers[id] = setTimeout(() => {
        delete revealFallbackTimers[id];
        dispatchRx({ t: "reveal-fallback-fired", id, gen });
      }, REVEAL_FALLBACK_MS);
      break;
    }
    case "tune-receivers": {
      pcs[action.id]?.getReceivers().forEach((r) => {
        if ("jitterBufferTarget" in r)
          (r as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = 50;
      });
      break;
    }
    case "request-reoffer":
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "request-reoffers", to: action.id }));
      break;
    case "schedule-retry": {
      clearTimeout(retryTimers[action.id]);
      const { id, gen } = action;
      retryTimers[id] = setTimeout(() => {
        delete retryTimers[id];
        dispatchRx({ t: "retry-fired", id, gen });
      }, RETRY_MS);
      break;
    }
    case "cancel-retry":
      clearTimeout(retryTimers[action.id]);
      delete retryTimers[action.id];
      break;
    case "stop-liveness":
      livenessWatchers[action.id]?.stop();
      delete livenessWatchers[action.id];
      break;
  }
}

// Tear a slot's media down (controller nulls the source, marks disconnected,
// stops the liveness watcher, cancels any retry) and drop its PC. A future offer
// rebuilds it.
function tearDownSlot(id: string): void {
  dispatchRx({ t: "peer-disconnected", id });
  pcs[id]?.close();
  delete pcs[id];
}

// The sender left the room for good: drop its media AND its membership, so the
// stage rearranges around the devices that are still here.
function dropSender(id: string): void {
  tearDownSlot(id);
  dispatchRx({ t: "sender-gone", id });
}

// ── Presence resync ─────────────────────────────────────────────────────────
// The register reply's `sender-connected` burst is an authoritative snapshot of
// the room, so after a reconnect we prune whatever it didn't mention (see
// staleJoins) — a sender that left while our socket was down, whose
// `peer-disconnected` we never received and whose pane would otherwise sit
// "waiting" forever.
//
// The snapshot's end is marked by a `pong`, NOT by a timer. `register` has no ack
// of its own, but the hub pushes the whole burst in one ordered batch and answers
// `ping` with `pong`, so a pong is proof the snapshot has already arrived. That
// matters in both directions: a timer long enough to be safe on a slow link is
// still a guess, and firing one on a snapshot that never came would tear down
// every live peer connection and cover the screen with the join card. Here, no
// pong simply means no prune — the heartbeat is already reconnecting.
let resyncSeen: Set<string> | null = null;

function beginResync(): void {
  resyncSeen = new Set();
}

function cancelResync(): void {
  resyncSeen = null;
}

function endResync(): void {
  const seen = resyncSeen;
  resyncSeen = null;
  if (!seen) return;
  for (const id of staleJoins(rxCtl, [...seen])) dropSender(id);
}

// Signaling doesn't depend on UI init: the DOM lookups above are guarded so
// module init always reaches this call and the socket always opens.
function connectWS(): void {
  // Any resync still in flight belonged to the socket we just lost — the
  // heartbeat's dead-socket path gets here without going through `onclose`.
  cancelResync();
  ws = new WebSocket(signalingUrl(room));
  const sock = ws;

  // Keep the receiver's slot from being reaped as a ghost while it sits idle
  // between layout changes, and detect a half-open socket so it reconnects
  // instead of leaving senders paired to a dead TV. startHeartbeat tears the
  // dead socket down; we just reopen if it's still the current one.
  const hb = startHeartbeat(sock, () => {
    if (ws === sock) connectWS();
  });

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "register", id: "receiver" }));
    // Chases the register: its pong is what closes the presence snapshot below.
    ws.send(JSON.stringify({ type: "ping" }));
    beginResync();
    // Every sender has to be told our pane sizes again on a fresh socket; the
    // cache can't know what they still hold.
    resetResHints();
  };

  ws.onmessage = (e: MessageEvent<string>) => {
    hb.alive();
    let msg: ReceiverInMsg;
    try {
      msg = JSON.parse(e.data) as ReceiverInMsg;
    } catch {
      return;
    }

    // Everything the hub had to say about the room has now been said.
    if (msg.type === "pong") endResync();

    if (msg.type === "sender-connected" && isDeviceId(msg.id)) {
      // A pane appears the moment the hub says the device is here, so its
      // "waiting" state is visible while it decides what to share.
      resyncSeen?.add(msg.id);
      dispatchRx({ t: "sender-joined", id: msg.id });
      // No speculative PC here: the reducer builds (and rebuilds) the peer
      // connection when the offer arrives, with the recvonly transceivers — so a
      // pre-created one would just be closed and replaced. Sending the initial
      // res-hint now lets the sender encode to this slot's size from its first
      // frame. Idempotent, so a late/duplicate sender-connected is harmless.
      sendResHints(msg.id);
    }

    if (msg.type === "offer") {
      // Every offer is a brand-new sender session (the sender always offers from a
      // fresh PC), so the reducer unconditionally rebuilds — see receiverReduce.
      dispatch({ t: "offer", id: msg.from, sdp: msg.sdp });
    }

    if (msg.type === "ice-candidate" && msg.candidate) {
      // Buffered until this slot's remote description is set, then flushed.
      dispatch({ t: "ice", id: msg.from, candidate: msg.candidate });
    }

    // Two ways a stream genuinely ends (vs a transient flap, which the liveness
    // arbiter keeps showing): the hub says the sender's socket left
    // (peer-disconnected), or the sender tells us it deliberately stopped sharing
    // (stream-stopped) — the latter blanks the slot instantly instead of waiting
    // out the liveness/heartbeat timeout. Both tear the slot's media down; a future
    // offer rebuilds it. Only the first means the DEVICE is gone, though: a sender
    // that stopped sharing is still in the room and keeps its pane.
    if (msg.type === "peer-disconnected") dropSender(msg.id);
    if (msg.type === "stream-stopped") tearDownSlot(msg.from);
  };

  ws.onclose = () => {
    hb.stop();
    cancelResync();
    setTimeout(connectWS, 3000);
  };
}

connectWS();
