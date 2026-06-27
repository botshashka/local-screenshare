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

const layoutBtn = document.getElementById("layoutBtn") as HTMLButtonElement;
const layoutLabel = document.getElementById("layoutLabel") as HTMLElement;
const layoutDots = document.getElementById("layoutDots") as HTMLElement;
const hint = document.getElementById("hint") as HTMLElement;

LAYOUTS.forEach(() => {
  const s = document.createElement("span");
  layoutDots.appendChild(s);
});

function updateLayoutUI(): void {
  const layout = LAYOUTS[layoutIdx];
  if (!layout) return;
  layoutLabel.textContent = layout.label;
  layoutDots
    .querySelectorAll("span")
    .forEach((s, i) => s.classList.toggle("active", i === layoutIdx));
}
updateLayoutUI();

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
  const prev = LAYOUTS[layoutIdx];
  if (prev) document.body.classList.remove(prev.cls);
  layoutIdx = newIdx;
  const next = LAYOUTS[layoutIdx];
  if (next) document.body.classList.add(next.cls);
  localStorage.setItem("layout", next?.cls ?? "");
  updateLayoutUI();
  sendResHints();
}

function cycleLayout(): void {
  applyLayout((layoutIdx + 1) % LAYOUTS.length);
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

layoutBtn.addEventListener("click", cycleLayout);

document.addEventListener("keydown", (e) => {
  if (e.key === "l" || e.key === "L" || e.key === " " || e.key === "ColorF3Blue") {
    e.preventDefault();
    cycleLayout();
  }
});

document.getElementById("slotB")!.addEventListener("click", () => {
  if (LAYOUTS[layoutIdx]?.cls === "pip-a") cycleLayout();
});
document.getElementById("slotA")!.addEventListener("click", () => {
  if (LAYOUTS[layoutIdx]?.cls === "pip-b") {
    const pipAIdx = LAYOUTS.findIndex((l) => l.cls === "pip-a");
    if (pipAIdx >= 0) applyLayout(pipAIdx);
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
      const pc = createPC(msg.id);
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
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
