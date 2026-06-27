import {
  wsUrl,
  tweakSdp,
  PRESETS,
  HEIGHT_LADDER,
  isPreset,
  resolvePresetName,
  computeEncoding,
  adaptStep,
  type QualityPreset,
  type ResTarget,
  type SenderInMsg,
} from "./rtc-utils.js";

type StatusClass = "" | "connected" | "error";

// The single outbound video stream's RTP sender + its outbound-rtp stats. The
// stats type augments the lib's narrow RTCOutboundRtpStreamStats with fields
// Chrome reports but TS doesn't model.
type VideoOutbound = RTCOutboundRtpStreamStats & {
  kind?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  qualityLimitationReason?: string;
  qualityLimitationDurations?: Record<string, number>;
};

function getVideoSender(pc: RTCPeerConnection): RTCRtpSender | undefined {
  return pc.getSenders().find((s) => s.track?.kind === "video");
}

async function getVideoOutbound(sender: RTCRtpSender): Promise<VideoOutbound | undefined> {
  let found: VideoOutbound | undefined;
  (await sender.getStats()).forEach((report) => {
    if (report.type === "outbound-rtp" && (report as VideoOutbound).kind === "video") {
      found = report as VideoOutbound;
    }
  });
  return found;
}

const FAVICON = { green: "#4ade80", amber: "#fbbf24", grey: "#6b7280" } as const;
type FaviconColor = (typeof FAVICON)[keyof typeof FAVICON];

const faviconCache = new Map<string, string>();
let currentFaviconColor = "";

function setFavicon(color: FaviconColor): void {
  if (color === currentFaviconColor) return;
  currentFaviconColor = color;
  let dataUrl = faviconCache.get(color);
  if (!dataUrl) {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(16, 16, 12, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    dataUrl = canvas.toDataURL();
    faviconCache.set(color, dataUrl);
  }
  const link = document.getElementById("favicon") as HTMLLinkElement;
  link.href = dataUrl;
}

function init(id: string): void {
  (document.getElementById("pickerScreen") as HTMLElement).style.display = "none";
  const main = document.getElementById("mainScreen") as HTMLElement;
  main.style.display = "flex";
  const label = id === "device-a" ? "Device A" : id === "device-b" ? "Device B" : id;
  (document.getElementById("idBadge") as HTMLElement).textContent = label;
  document.body.classList.add(id); // drives the badge's red/green accent
  document.title = `Sender: ${label}`;
  startSender(id);
}

(document.getElementById("btnA") as HTMLButtonElement).addEventListener("click", () =>
  init("device-a"),
);
(document.getElementById("btnB") as HTMLButtonElement).addEventListener("click", () =>
  init("device-b"),
);

// DOM-bound wrapper around the pure resolvePresetName: reads the ?preset= URL
// param (persisting an explicit choice) and the saved value, and supplies the
// machine's core count for the default.
function resolvePreset(): { name: QualityPreset; maxHeight: number; bpp: number } {
  const fromUrl = new URLSearchParams(location.search).get("preset");
  if (isPreset(fromUrl)) localStorage.setItem("preset", fromUrl);
  const name = resolvePresetName(
    fromUrl,
    localStorage.getItem("preset"),
    navigator.hardwareConcurrency || 4,
  );
  return { name, ...PRESETS[name] };
}

function startSender(id: string): void {
  let pc: RTCPeerConnection | null = null;
  let ws: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let receiverReady = false;
  // Default to a full-panel target until the receiver's first measured hint
  // arrives; the cap below keeps this from over-encoding on connect.
  let currentTarget: ResTarget = { w: 3840, h: 2160 };
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  let quality = resolvePreset();
  // Auto-adapt's live ceiling: starts at the preset ceiling and steps down the
  // ladder under sustained CPU strain, recovering once comfortable. Never
  // exceeds quality.maxHeight. (VP9 is software-encoded on Mac — no hardware
  // encoder — so the encode height is the real CPU lever.)
  let activeCapHeight = quality.maxHeight;
  // bitrate = pixels × fps × bpp is a ceiling, not a floor: static screen
  // content uses far less and only spikes the encoder on change, so a generous
  // cap buys sharpness on motion without constant load. We're on a LAN (no
  // relays), so bandwidth is cheap — CPU is the real budget. MAX holds ~0.1 bpp
  // at full 4K (3840×2160×30×0.1 ≈ 25 Mbps) so the top preset isn't starved.
  const FPS = 30;
  const MIN_BITRATE = 300_000;
  const MAX_BITRATE = 25_000_000;

  const statusEl = document.getElementById("status") as HTMLElement;
  const statusText = document.getElementById("statusText") as HTMLElement;
  const shareBtn = document.getElementById("shareBtn") as HTMLButtonElement;
  const preview = document.getElementById("preview") as HTMLVideoElement;

  function setStatus(msg: string, cls: StatusClass = ""): void {
    // Only the text span — the status keeps its leading indicator dot.
    statusText.textContent = msg;
    statusEl.className = "status " + cls;
  }

  function updateFavicon(): void {
    if (pc?.connectionState === "connected" && stream) {
      setFavicon(FAVICON.green);
    } else if (receiverReady) {
      setFavicon(FAVICON.amber);
    } else {
      setFavicon(FAVICON.grey);
    }
  }

  async function applyTarget(target: ResTarget): Promise<void> {
    currentTarget = target;
    if (!pc || pc.connectionState !== "connected") return;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const settings = sender.track.getSettings();

      const { scale, bitrate } = computeEncoding({
        capW: settings.width ?? 1920,
        capH: settings.height ?? 1080,
        target,
        capHeight: activeCapHeight,
        bpp: quality.bpp,
        fps: FPS,
        minBitrate: MIN_BITRATE,
        maxBitrate: MAX_BITRATE,
      });

      const params = sender.getParameters();
      if (!params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      if (!enc) continue;
      enc.networkPriority = "high";
      enc.priority = "high";
      enc.maxBitrate = bitrate;
      enc.scaleResolutionDownBy = scale;
      await sender.setParameters(params).catch(() => {});
    }
  }

  // ── Runtime auto-adapt ──────────────────────────────────────────────────
  // Lower the encode ceiling if the encoder reports sustained CPU limitation,
  // raise it back (up to the preset) once it's comfortable. Reads
  // qualityLimitationDurations (cumulative seconds the encoder spent limited),
  // which is steadier than the instantaneous qualityLimitationReason.
  const ADAPT_MS = 4000;
  let prevCpuSec = 0;
  let strain = 0;
  let comfort = 0;

  function resetAdaptBaseline(): void {
    // Stats are per-peer-connection and reset to 0 on a fresh offer; re-baseline
    // so the first interval after a (re)connect doesn't read a bogus delta.
    prevCpuSec = 0;
    strain = 0;
    comfort = 0;
  }

  // Apply a chosen preset: rebuild the active settings, snap the live cap to the
  // new ceiling (auto-adapt re-probes from there), and reset the strain/comfort
  // counters. Callers handle persistence / re-encoding.
  function setPreset(p: QualityPreset): void {
    quality = { name: p, ...PRESETS[p] };
    activeCapHeight = quality.maxHeight;
    strain = 0;
    comfort = 0;
    console.info(`[screenshare] preset: ${quality.name} (cap ${quality.maxHeight}p)`);
  }
  setPreset(quality.name); // log + normalize initial state

  async function pollAdapt(): Promise<void> {
    if (!pc || pc.connectionState !== "connected") return;
    const vSender = getVideoSender(pc);
    if (!vSender) return;
    const cpuSec = (await getVideoOutbound(vSender))?.qualityLimitationDurations?.["cpu"];
    if (cpuSec === undefined) return;

    // Fraction of this interval the encoder was CPU-limited (clamp negatives in
    // case stats reset under us between polls).
    const dCpu = Math.max(0, cpuSec - prevCpuSec);
    prevCpuSec = cpuSec;
    const cpuFraction = dCpu / (ADAPT_MS / 1000);

    const fromRung = HEIGHT_LADDER.indexOf(activeCapHeight);
    const ceilingRung = HEIGHT_LADDER.indexOf(quality.maxHeight);
    const next = adaptStep({ rung: fromRung, strain, comfort }, cpuFraction, ceilingRung);
    strain = next.strain;
    comfort = next.comfort;
    if (next.rung === fromRung) return;

    activeCapHeight = HEIGHT_LADDER[next.rung]!;
    setStatus(
      next.rung < fromRung
        ? `High CPU — encoding capped at ${activeCapHeight}p`
        : "Streaming to TV",
      "connected",
    );
    void applyTarget(currentTarget);
  }

  setInterval(() => void pollAdapt(), ADAPT_MS);

  // Preset segmented control — writes the same localStorage key as ?preset=
  // and applies live. Switching snaps the cap to the new ceiling; auto-adapt
  // re-probes from there, so a higher preset on a weak machine can still settle
  // lower. The active segment reflects the chosen ceiling, not the live cap.
  const seg = document.getElementById("qualitySeg");
  if (seg) {
    const buttons = Array.from(seg.querySelectorAll<HTMLButtonElement>("button[data-preset]"));
    const markActive = (name: string): void => {
      for (const b of buttons) b.classList.toggle("active", b.dataset["preset"] === name);
    };
    markActive(quality.name);
    for (const b of buttons) {
      b.addEventListener("click", () => {
        const name = b.dataset["preset"];
        if (!isPreset(name)) return;
        localStorage.setItem("preset", name);
        setPreset(name);
        markActive(name);
        void applyTarget(currentTarget);
      });
    }
  }

  // ── Live stats overlay (toggle with "s") ────────────────────────────────
  // What you actually get, end to end: capture size (source ceiling), the
  // encoded frame the receiver is sent, framerate, measured bitrate, and the
  // encoder's quality-limitation reason. Off by default; polls only while shown.
  const statsEl = document.getElementById("stats") as HTMLElement | null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let prevBytes = 0;
  let prevStatsTs = 0;

  async function pollStats(): Promise<void> {
    if (!statsEl) return;
    if (!pc || pc.connectionState !== "connected") {
      statsEl.textContent = `${id} · ${quality.name}\nnot connected`;
      return;
    }
    const vSender = getVideoSender(pc);
    const settings = vSender?.track?.getSettings();
    const r = vSender ? await getVideoOutbound(vSender) : undefined;

    const bytes = r?.bytesSent ?? 0;
    const ts = r?.timestamp ?? 0;
    const dt = ts && prevStatsTs ? (ts - prevStatsTs) / 1000 : 0;
    const mbps = dt > 0 ? ((bytes - prevBytes) * 8) / dt / 1e6 : 0;
    prevBytes = bytes;
    prevStatsTs = ts;

    const cap = `${settings?.width ?? "?"}×${settings?.height ?? "?"}`;
    statsEl.textContent =
      `${id} · ${quality.name} (cap ${activeCapHeight}p)\n` +
      `capture  ${cap}\n` +
      `encode   ${r?.frameWidth ?? 0}×${r?.frameHeight ?? 0} @ ${Math.round(r?.framesPerSecond ?? 0)}fps\n` +
      `bitrate  ${mbps.toFixed(1)} Mbps\n` +
      `limit    ${r?.qualityLimitationReason ?? "—"}`;
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "s" && e.key !== "S") return;
    if (!statsEl) return;
    const show = !statsEl.classList.contains("show");
    statsEl.classList.toggle("show", show);
    if (show) {
      prevBytes = 0;
      prevStatsTs = 0;
      void pollStats();
      statsTimer = setInterval(() => void pollStats(), 1000);
    } else if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  });

  async function makeOffer(): Promise<void> {
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: [] });
    resetAdaptBaseline();

    for (const track of stream!.getTracks()) pc.addTrack(track, stream!);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        ws?.send(JSON.stringify({ type: "ice-candidate", to: "receiver", from: id, candidate }));
    };

    pc.onconnectionstatechange = async () => {
      const state = pc?.connectionState;
      if (state === "connected") {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        setStatus("Streaming to TV", "connected");
        updateFavicon();
        await applyTarget(currentTarget);
      }
      if (state === "failed" && !retryTimer) {
        setStatus("Connection failed — retrying…", "error");
        updateFavicon();
        const thisPc = pc;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (stream && receiverReady && pc === thisPc) void makeOffer();
        }, 3000);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws?.send(
      JSON.stringify({
        type: "offer",
        to: "receiver",
        from: id,
        sdp: tweakSdp(offer.sdp ?? "", true),
      }),
    );
  }

  function connectWS(): void {
    const sock = new WebSocket(wsUrl);
    ws = sock;

    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "register", id }));
      setStatus("Connected to server — waiting for TV receiver…");
      shareBtn.disabled = false;
      updateFavicon();
    };

    sock.onmessage = async (e: MessageEvent<string>) => {
      let msg: SenderInMsg;
      try {
        msg = JSON.parse(e.data) as SenderInMsg;
      } catch {
        return;
      }

      if (msg.type === "receiver-ready") {
        receiverReady = true;
        setStatus("TV receiver connected", "connected");
        updateFavicon();
        if (stream) await makeOffer();
      }
      if (msg.type === "answer") {
        await pc?.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
      }
      if (msg.type === "ice-candidate" && msg.candidate) {
        await pc?.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
      if (msg.type === "peer-disconnected") {
        setStatus("TV disconnected — reconnecting when it returns…");
        receiverReady = false;
        updateFavicon();
        pc?.close();
        pc = null;
      }
      if (msg.type === "request-reoffers" && stream) {
        await makeOffer();
      }
      if (msg.type === "res-hint") {
        await applyTarget(msg.target);
      }
    };

    sock.onclose = () => {
      ws = null;
      setStatus("Server disconnected — retrying in 3s…", "error");
      shareBtn.disabled = true;
      receiverReady = false;
      // Keep the capture + peer connection alive: media is P2P and keeps
      // flowing to the TV while signaling is down. We re-offer on reconnect.
      updateFavicon();
      setTimeout(connectWS, 3000);
    };
  }

  shareBtn.addEventListener("click", () => {
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            // Capture at native (up to 4K) so a focused stream on a 4K panel
            // can be genuinely sharp. Capture resolution doesn't affect latency,
            // and pip/side panes are downscaled per the receiver's measured
            // target, so this costs nothing until a stream is actually focused.
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
          },
        });
        stream.getVideoTracks().forEach((t) => {
          t.contentHint = "detail";
        });
        preview.srcObject = stream;
        preview.classList.add("visible");
        shareBtn.textContent = "Re-share Screen";

        stream.getVideoTracks()[0]!.onended = () => {
          setStatus("Screen share stopped");
          stream = null;
          preview.classList.remove("visible");
          pc?.close();
          pc = null;
          updateFavicon();
        };

        if (receiverReady) await makeOffer();
        else setStatus("Waiting for TV receiver…");
        updateFavicon();
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`, "error");
        updateFavicon();
      }
    })();
  });

  setFavicon(FAVICON.grey);
  connectWS();
}

// Auto-start from a ?id= URL. Kept at the end of the module so every top-level
// const (PRESETS, etc.) is initialized before init() → startSender() runs —
// otherwise the auto-init path hits a temporal-dead-zone error.
const paramId = new URLSearchParams(location.search).get("id");
if (paramId) init(paramId);
