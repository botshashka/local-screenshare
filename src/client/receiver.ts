import {
  STUN,
  signalingHost,
  signalingUrl,
  generateRoomCode,
  coerceRoomCode,
  persistRoomInUrl,
  startHeartbeat,
  trackConnectionLiveness,
  type ResTarget,
  type ReceiverInMsg,
} from "./rtc-utils.js";
import {
  receiverReduce,
  initialReceiverState,
  type ReceiverState,
  type ReceiverEvent,
  type ReceiverAction,
} from "./receiver-session.js";

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

const LAYOUTS = [
  { cls: "side-by-side", label: "Side by Side" },
  { cls: "pip-a", label: "Device A Focus" },
  { cls: "pip-b", label: "Device B Focus" },
  { cls: "solo-a", label: "Device A Only" },
  { cls: "solo-b", label: "Device B Only" },
] as const;

type LayoutCls = (typeof LAYOUTS)[number]["cls"];

// A display:none slot (solo's hidden device) measures 0×0. Keep streaming it at
// a low-res thumbnail so toggling it back is instant rather than a black frame.
const MIN_TARGET: ResTarget = { w: 426, h: 240 };
// .slot has a 0.25s CSS transition; wait it out before measuring final geometry.
const LAYOUT_SETTLE_MS = 300;

let layoutIdx = Math.max(
  0,
  LAYOUTS.findIndex((l) => l.cls === localStorage.getItem("layout")),
);

// Remembered "show the other device in the corner" preference, so turning the
// corner off persists when you pass through Side by Side and focus again. A
// focus layout in storage is authoritative; otherwise fall back to the pref.
let showSecondary = localStorage.getItem("showSecondary") !== "false";
const initialCls = LAYOUTS[layoutIdx]?.cls;
if (initialCls === "solo-a" || initialCls === "solo-b") showSecondary = false;
else if (initialCls === "pip-a" || initialCls === "pip-b") showSecondary = true;

const layoutBtn = document.getElementById("layoutBtn") as HTMLButtonElement;
const layoutLabel = document.getElementById("layoutLabel") as HTMLElement;
const layoutDots = document.getElementById("layoutDots") as HTMLElement;
const hint = document.getElementById("hint") as HTMLElement;
const legend = document.getElementById("legend") as HTMLElement;
const blueLabel = document.getElementById("blueLabel") as HTMLElement;

LAYOUTS.forEach(() => {
  const s = document.createElement("span");
  layoutDots?.appendChild(s);
});

function updateLayoutUI(): void {
  const layout = LAYOUTS[layoutIdx];
  if (!layout || !layoutLabel || !layoutDots) return;
  layoutLabel.textContent = layout.label;
  layoutDots
    .querySelectorAll("span")
    .forEach((s, i) => s.classList.toggle("active", i === layoutIdx));
}
updateLayoutUI();

// The color-key legend (top overlay) mirrors the four TV remote buttons.
// Red/Green/Yellow are destinations highlighting the focused device; Blue
// toggles the corner picture, so its label is contextual to the layout.
type ColorName = "red" | "green" | "yellow";
const LEGEND: Record<LayoutCls, { active: ColorName; blue: string; dim?: boolean }> = {
  "side-by-side": { active: "yellow", blue: "Show in corner", dim: true },
  "pip-a": { active: "red", blue: "Hide Device B" },
  "solo-a": { active: "red", blue: "Show Device B" },
  "pip-b": { active: "green", blue: "Hide Device A" },
  "solo-b": { active: "green", blue: "Show Device A" },
};

function updateLegend(): void {
  const cls = LAYOUTS[layoutIdx]?.cls;
  if (!cls || !legend || !blueLabel) return;
  const info = LEGEND[cls];
  legend
    .querySelectorAll<HTMLElement>(".pill")
    .forEach((p) => p.classList.toggle("active", p.dataset.color === info.active));
  blueLabel.textContent = info.blue;
  legend
    .querySelector<HTMLElement>('.pill[data-color="blue"]')
    ?.classList.toggle("dim", info.dim ?? false);
}
updateLegend();

let legendTimer: ReturnType<typeof setTimeout>;
function showLegend(): void {
  if (!legend) return;
  updateLegend();
  legend.classList.add("show");
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => legend.classList.remove("show"), 4000);
}

const slots: Record<string, HTMLElement> = {
  "device-a": document.getElementById("slotA") as HTMLElement,
  "device-b": document.getElementById("slotB") as HTMLElement,
};
const videos: Record<string, HTMLVideoElement> = {
  "device-a": document.getElementById("videoA") as HTMLVideoElement,
  "device-b": document.getElementById("videoB") as HTMLVideoElement,
};

const pcs: Record<string, RTCPeerConnection> = {};
const retryTimers: Record<string, ReturnType<typeof setTimeout>> = {};
// Per-sender connection-liveness watchers (transient-flap vs. real-loss arbiter).
const livenessWatchers: Record<string, ReturnType<typeof trackConnectionLiveness>> = {};

// ── Room ─────────────────────────────────────────────────────────────────────
// Rooms exist only to isolate tenants on a shared public hub. A co-located
// `server.ts` is a single global hub with nothing to isolate, so the whole room
// feature (code + QR panel here, join code on the sender) is active only when a
// hub is configured. With none, this stays empty and the panel is hidden — the
// local `pnpm start` flow is unchanged.
const params = new URLSearchParams(location.search);
const hubConfigured = signalingHost() !== null;
// Gates the per-slot join prompt CSS (only meaningful when rooms exist).
if (hubConfigured) document.body.classList.add("hub");
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

  // Mirror the same QR / domain / code into each empty-slot join prompt, so a
  // second sender can still scan in after the big room card has gone away.
  document.querySelectorAll<HTMLImageElement>(".slot-qr").forEach((el) => {
    if (qrDataUrl) el.src = qrDataUrl;
  });
  document.querySelectorAll(".slot-domain").forEach((el) => {
    el.textContent = location.host;
  });
  document.querySelectorAll(".slot-code").forEach((el) => {
    el.textContent = room;
  });
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
        if (joinErr) joinErr.textContent = "Enter the 8-character code shown on the other screen.";
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

function updateRoomPanel(): void {
  if (!roomPanel) return;
  clearTimeout(roomPanelGraceTimer);
  roomPanelGraceTimer = undefined;
  if (!hubConfigured) {
    // Local single-hub server: no join screen. Keep the card hidden and reveal
    // the TV chrome (body starts in `joining` to avoid a first-paint flash).
    showRoomPanel(false);
    return;
  }
  const anyConnected = Object.values(slots).some((s) => s.classList.contains("connected"));
  if (anyConnected) {
    showRoomPanel(false);
    return;
  }
  // Nothing connected — wait out the grace window before revealing the card, in
  // case a device is mid-(re)connect. Re-check on fire, since a connection may
  // have landed during the wait.
  roomPanelGraceTimer = setTimeout(() => {
    roomPanelGraceTimer = undefined;
    const stillNone = !Object.values(slots).some((s) => s.classList.contains("connected"));
    if (stillNone) showRoomPanel(true);
  }, ROOM_PANEL_GRACE_MS);
}
updateRoomPanel();

const currentLayout = LAYOUTS[layoutIdx];
if (currentLayout) document.body.classList.add(currentLayout.cls);

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

function sendResHints(onlyFor?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const [to, slot] of Object.entries(slots)) {
    if (onlyFor && to !== onlyFor) continue;
    ws.send(
      JSON.stringify({ type: "res-hint", to, from: "receiver", target: targetForSlot(slot) }),
    );
  }
}

// Layout changes and window resizes animate/resize the slots, so measure once
// the geometry has settled rather than mid-transition.
let resHintTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleResHints(): void {
  clearTimeout(resHintTimer);
  resHintTimer = setTimeout(() => sendResHints(), LAYOUT_SETTLE_MS);
}

function applyLayout(newIdx: number): void {
  if (newIdx === layoutIdx) return;
  const prev = LAYOUTS[layoutIdx];
  if (prev) document.body.classList.remove(prev.cls);
  layoutIdx = newIdx;
  const next = LAYOUTS[layoutIdx];
  if (next) document.body.classList.add(next.cls);
  localStorage.setItem("layout", next?.cls ?? "");
  if (next?.cls === "pip-a" || next?.cls === "pip-b") showSecondary = true;
  else if (next?.cls === "solo-a" || next?.cls === "solo-b") showSecondary = false;
  localStorage.setItem("showSecondary", String(showSecondary));
  updateLayoutUI();
  updateLegend();
  scheduleResHints();
}

// The TV panel is fixed, but a resized browser window (dev/desktop) changes slot
// sizes — re-measure when it settles.
window.addEventListener("resize", scheduleResHints);

function cycleLayout(): void {
  applyLayout((layoutIdx + 1) % LAYOUTS.length);
}

function applyByCls(cls: LayoutCls): void {
  const idx = LAYOUTS.findIndex((l) => l.cls === cls);
  if (idx >= 0) applyLayout(idx);
}

// Focus a device, honoring the remembered corner preference — so a hidden
// corner stays hidden (and "fullscreen single" stays fullscreen) as you flip
// A↔B or pass through Side by Side.
function focusDevice(dev: "a" | "b"): void {
  applyByCls(showSecondary ? `pip-${dev}` : `solo-${dev}`);
}

function sideBySide(): void {
  applyByCls("side-by-side");
}

// Blue: show/hide the non-focused device in the corner. No-op on side-by-side.
function toggleSecondary(): void {
  const cls = LAYOUTS[layoutIdx]?.cls;
  if (cls === "side-by-side" || !cls) return;
  const dev = cls.endsWith("-a") ? "a" : "b";
  applyByCls(cls.startsWith("pip") ? `solo-${dev}` : `pip-${dev}`);
}

// Mark a slot's stream as not-currently-live: drop the `connected` class and let
// the room panel reconsider showing the join card.
//
// INVARIANT — do not clear `video.srcObject` here, and do not let any
// transient/recoverable drop reach a place that does. This rests on a browser
// semantic that no test in this repo can verify (a fake PC would just assume it):
// when ICE self-heals from `disconnected` back to `connected`, the *same* track
// resumes and `ontrack` does NOT fire again. So nulling the source on a flap
// would leave the slot permanently blank until a page reload — the original bug.
// We instead keep the last frame (it freezes, then unfreezes on heal). The source
// is nulled in exactly one place: the `peer-disconnected` handler, where the hub
// has told us the sender truly left and a fresh `ontrack` is coming via rebuild.
// If you change this, re-verify in real Chrome via the DevTools offline toggle.
function markDisconnected(id: string): void {
  const slot = slots[id];
  if (slot) {
    slot.classList.remove("connected");
    slot.classList.add("disconnected");
  }
  updateRoomPanel();
}

// Mark a slot live and hide the join panel. Normally fired on the first decoded
// frame; also used as a fallback once the peer connection reports `connected`,
// so a stream that never decodes a frame can't leave the join card stuck over a
// live connection.
function revealSlot(id: string): void {
  const slot = slots[id];
  if (!slot) return;
  slot.classList.remove("disconnected");
  slot.classList.add("connected");
  updateRoomPanel();
}

layoutBtn?.addEventListener("click", cycleLayout);

// TV remote color buttons drive direct selection, with r/g/y/b as desktop
// equivalents. e.key carries "ColorFxName" on modern firmware; keyCode 403–406
// is the fallback for sets that don't.
const REMOTE_ACTIONS = [
  { key: "ColorF0Red", letter: "r", code: 403, run: () => focusDevice("a") },
  { key: "ColorF1Green", letter: "g", code: 404, run: () => focusDevice("b") },
  { key: "ColorF2Yellow", letter: "y", code: 405, run: sideBySide },
  { key: "ColorF3Blue", letter: "b", code: 406, run: toggleSecondary },
] as const;

document.addEventListener("keydown", (e) => {
  // While the join popup is up it covers the screen and there's nothing to lay
  // out, so don't claim the remote hotkeys — let keys reach the code input.
  if (roomPanel && !roomPanel.classList.contains("hidden")) return;
  if (e.key === "l" || e.key === "L" || e.key === " ") {
    e.preventDefault();
    cycleLayout();
    return;
  }
  const letter = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const match = REMOTE_ACTIONS.find(
    (a) => a.key === e.key || a.letter === letter || a.code === e.keyCode,
  );
  if (match) {
    e.preventDefault();
    match.run();
    showLegend();
  }
});

document.getElementById("slotB")?.addEventListener("click", () => {
  if (LAYOUTS[layoutIdx]?.cls === "pip-a") focusDevice("b");
});
document.getElementById("slotA")?.addEventListener("click", () => {
  if (LAYOUTS[layoutIdx]?.cls === "pip-b") focusDevice("a");
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

function createPC(senderId: string): RTCPeerConnection {
  pcs[senderId]?.close();
  livenessWatchers[senderId]?.stop();

  // A fresh PC for this slot means a fresh stream: drop any stale/ended tracks
  // from a prior connection so the rebuild's ontrack starts clean (ontrack below
  // appends into this). Harmless on the first-ever connection (was null).
  const video = videos[senderId];
  if (video) video.srcObject = new MediaStream();

  const pc = new RTCPeerConnection(STUN);
  pcs[senderId] = pc;

  // Decide transient flap vs. real loss: only escalate (tear the slot down and
  // re-offer) on a `failed`, or a `disconnected` that doesn't self-heal in time.
  const watcher = trackConnectionLiveness({
    onLost: () => {
      if (pcs[senderId] !== pc) return; // superseded by a newer PC
      markDisconnected(senderId);
      if (!retryTimers[senderId]) {
        retryTimers[senderId] = setTimeout(() => {
          delete retryTimers[senderId];
          if (pcs[senderId] === pc && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "request-reoffers", to: senderId }));
          }
        }, 2000);
      }
    },
  });
  livenessWatchers[senderId] = watcher;

  pc.ontrack = (e) => {
    const video = videos[senderId];
    if (!video) return;
    if (!video.srcObject) video.srcObject = new MediaStream();
    (video.srcObject as MediaStream).addTrack(e.track);
    video.muted = false;
    if (!slots[senderId]) return;
    // Keep the video hidden until the first frame is actually decoded.
    // Revealing it the moment a track arrives shows the browser's native
    // play-button placeholder for ~0.5s while it waits for frames.
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => void;
      }
    ).requestVideoFrameCallback;
    if (rvfc) {
      rvfc.call(video, () => revealSlot(senderId));
    } else {
      video.addEventListener("playing", () => revealSlot(senderId), { once: true });
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate)
      ws.send(JSON.stringify({ type: "ice-candidate", to: senderId, from: "receiver", candidate }));
  };

  pc.onconnectionstatechange = () => {
    // The watcher arbitrates disconnect/failed → its onLost does the teardown.
    watcher.update(pc.connectionState);
    if (pc.connectionState === "connected") {
      clearTimeout(retryTimers[senderId]);
      delete retryTimers[senderId];
      pc.getReceivers().forEach((r) => {
        if ("jitterBufferTarget" in r)
          (r as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = 50;
      });
      // Fallback for a connected-but-never-decoding stream: the first-frame
      // reveal above is the normal path, but if no frame arrives within the
      // grace window, reveal anyway so the join card doesn't sit over a live
      // connection. revealSlot is idempotent, so a frame landing first wins.
      setTimeout(() => {
        if (pcs[senderId] === pc && pc.connectionState === "connected") revealSlot(senderId);
      }, REVEAL_FALLBACK_MS);
    }
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
      const pc = createPC(action.id);
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
        .catch(() => dispatch({ t: "op-failed", id: action.id, epoch: action.epoch, op: "remote" }));
      break;
    }
    case "create-answer": {
      const pc = pcs[action.id];
      if (!pc || negEpoch[action.id] !== action.epoch) break;
      pc.createAnswer()
        .then(async (answer) => {
          await pc.setLocalDescription(answer);
          dispatch({ t: "answer-created", id: action.id, epoch: action.epoch, sdp: answer.sdp ?? "" });
        })
        .catch(() => dispatch({ t: "op-failed", id: action.id, epoch: action.epoch, op: "answer" }));
      break;
    }
    case "send-answer": {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "answer", to: action.id, from: "receiver", sdp: action.sdp }));
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

// Signaling doesn't depend on UI init: the DOM lookups above are guarded so
// module init always reaches this call and the socket always opens.
function connectWS(): void {
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
  };

  ws.onmessage = (e: MessageEvent<string>) => {
    hb.alive();
    let msg: ReceiverInMsg;
    try {
      msg = JSON.parse(e.data) as ReceiverInMsg;
    } catch {
      return;
    }

    if (msg.type === "sender-connected") {
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

    if (msg.type === "peer-disconnected") {
      // The hub says this sender has genuinely left — no rebuild is coming, so
      // tear the slot fully down and clear the video (the one place we null the
      // source; a mere ICE flap must not reach here).
      const { id } = msg;
      markDisconnected(id);
      livenessWatchers[id]?.stop();
      delete livenessWatchers[id];
      clearTimeout(retryTimers[id]);
      delete retryTimers[id];
      pcs[id]?.close();
      delete pcs[id];
      const video = videos[id];
      if (video) video.srcObject = null;
    }
  };

  ws.onclose = () => {
    hb.stop();
    setTimeout(connectWS, 3000);
  };
}

connectWS();
