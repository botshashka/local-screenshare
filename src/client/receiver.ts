import { wsUrl, tweakSdp, type DeviceId, type ResHint, type ReceiverInMsg } from "./rtc-utils.js";

const LAYOUTS = [
  { cls: "side-by-side", label: "Side by Side" },
  { cls: "pip-a", label: "Device A Focus" },
  { cls: "pip-b", label: "Device B Focus" },
  { cls: "solo-a", label: "Device A Only" },
  { cls: "solo-b", label: "Device B Only" },
] as const;

type LayoutCls = (typeof LAYOUTS)[number]["cls"];

// solo-a/solo-b use the same hint distribution as pip-a/pip-b
const FOCUS_A: Record<DeviceId, ResHint> = { "device-a": "full", "device-b": "pip" };
const FOCUS_B: Record<DeviceId, ResHint> = { "device-a": "pip", "device-b": "full" };

const RES_HINTS: Record<LayoutCls, Record<DeviceId, ResHint>> = {
  "side-by-side": { "device-a": "side", "device-b": "side" },
  "pip-a": FOCUS_A,
  "pip-b": FOCUS_B,
  "solo-a": FOCUS_A,
  "solo-b": FOCUS_B,
};

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

const currentLayout = LAYOUTS[layoutIdx];
if (currentLayout) document.body.classList.add(currentLayout.cls);

let ws: WebSocket;

function sendResHints(onlyFor?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const layout = LAYOUTS[layoutIdx];
  if (!layout) return;
  const hints = RES_HINTS[layout.cls];
  for (const [to, hintVal] of Object.entries(hints)) {
    if (onlyFor && to !== onlyFor) continue;
    ws.send(JSON.stringify({ type: "res-hint", to, from: "receiver", hint: hintVal }));
  }
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
  sendResHints();
}

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

function markDisconnected(id: string): void {
  const slot = slots[id];
  if (slot) {
    slot.classList.remove("connected");
    slot.classList.add("disconnected");
  }
  const video = videos[id];
  if (video) video.srcObject = null;
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

  const pc = new RTCPeerConnection({ iceServers: [] });
  pcs[senderId] = pc;

  pc.ontrack = (e) => {
    const video = videos[senderId];
    if (!video) return;
    if (!video.srcObject) video.srcObject = new MediaStream();
    (video.srcObject as MediaStream).addTrack(e.track);
    video.muted = false;
    const slot = slots[senderId];
    if (!slot) return;
    slot.classList.remove("disconnected");
    slot.classList.add("connected");
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate)
      ws.send(JSON.stringify({ type: "ice-candidate", to: senderId, from: "receiver", candidate }));
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      clearTimeout(retryTimers[senderId]);
      delete retryTimers[senderId];
      pc.getReceivers().forEach((r) => {
        if ("jitterBufferTarget" in r)
          (r as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = 50;
      });
    }
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      markDisconnected(senderId);
      if (!retryTimers[senderId]) {
        retryTimers[senderId] = setTimeout(() => {
          delete retryTimers[senderId];
          if (pcs[senderId] === pc && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "request-reoffers", to: senderId }));
          }
        }, 2000);
      }
    }
  };

  return pc;
}

// Signaling doesn't depend on UI init: the DOM lookups above are guarded so
// module init always reaches this call and the socket always opens.
function connectWS(): void {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "register", id: "receiver" }));
  };

  ws.onmessage = async (e: MessageEvent<string>) => {
    let msg: ReceiverInMsg;
    try {
      msg = JSON.parse(e.data) as ReceiverInMsg;
    } catch {
      return;
    }

    if (msg.type === "sender-connected") {
      // Idempotent: a late/duplicate sender-connected must not recreate (and so
      // close, via createPC) a peer connection an earlier offer already set up.
      if (!pcs[msg.id]) {
        const pc = createPC(msg.id);
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
      }
      sendResHints(msg.id);
    }

    if (msg.type === "offer") {
      const senderId = msg.from;
      const pc = pcs[senderId] ?? createPC(senderId);
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: msg.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(
        JSON.stringify({
          type: "answer",
          to: senderId,
          from: "receiver",
          sdp: tweakSdp(answer.sdp ?? ""),
        }),
      );
    }

    if (msg.type === "ice-candidate" && msg.candidate) {
      const pc = pcs[msg.from];
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }

    if (msg.type === "peer-disconnected") {
      const { id } = msg;
      markDisconnected(id);
      pcs[id]?.close();
      delete pcs[id];
    }
  };

  ws.onclose = () => setTimeout(connectWS, 3000);
}

connectWS();
