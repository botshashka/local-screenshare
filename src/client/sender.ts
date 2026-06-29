import {
  STUN,
  signalingHost,
  signalingUrl,
  clientToken,
  coerceRoomCode,
  persistRoomInUrl,
  PRESETS,
  HEIGHT_LADDER,
  isPreset,
  resolvePresetName,
  computeEncoding,
  adaptStep,
  isDeviceId,
  startHeartbeat,
  type DeviceId,
  type QualityPreset,
  type ResTarget,
  type SenderInMsg,
} from "./rtc-utils.js";
import {
  senderReduce,
  initialSenderState,
  type SenderState,
  type SenderEvent,
  type SenderAction,
} from "./sender-session.js";
import {
  senderControllerReduce,
  senderView,
  initialControllerState,
  type SenderControllerState,
  type SenderControllerEvent,
  type SenderControllerAction,
} from "./sender-controller.js";

// The room code this sender pairs through. Set during room resolution at the
// bottom of the module before startSender() runs.
let room = "";

// Parsed once and reused across the module (room resolution, ?id= hint, ?preset=).
const params = new URLSearchParams(location.search);

// An optional slot hint from ?id=device-a/-b. The hub still owns assignment —
// this is only honored when that slot is free, so it can't steal an in-use one.
const idParam = params.get("id");
const preferId: DeviceId | null = isDeviceId(idParam) ? idParam : null;

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

// Reveal the main sender UI (the card is shown from the start in a "joining"
// state; this fills in the assigned identity). Set the badge label + accent and
// the tab title from the slot the hub handed us.
function showAssigned(id: DeviceId): void {
  const label = id === "device-a" ? "Device A" : "Device B";
  (document.getElementById("idBadge") as HTMLElement).textContent = label;
  document.body.classList.remove("device-a", "device-b");
  document.body.classList.add(id); // drives the badge's red/green accent
  document.title = `Sender: ${label}`;
}

// DOM-bound wrapper around the pure resolvePresetName: reads the ?preset= URL
// param (persisting an explicit choice) and the saved value, and supplies the
// machine's core count for the default.
function resolvePreset(): { name: QualityPreset; maxHeight: number; bpp: number } {
  const fromUrl = params.get("preset");
  if (isPreset(fromUrl)) localStorage.setItem("preset", fromUrl);
  const name = resolvePresetName(
    fromUrl,
    localStorage.getItem("preset"),
    navigator.hardwareConcurrency || 4,
  );
  return { name, ...PRESETS[name] };
}

function startSender(): void {
  // Our slot, assigned by the hub on register. Empty until the `assigned` reply
  // arrives; nothing that needs it (offers, ICE) runs before then.
  let myId: DeviceId | "" = "";
  let pc: RTCPeerConnection | null = null;
  let ws: WebSocket | null = null;
  // The capture the next/current PC is built from — written ONLY by the
  // controller's `use-capture` action (so every PC is provably built from the
  // current capture). `captures` holds every acquired stream by generation; the
  // controller references them by gen and the adapter does the real stop/swap.
  let stream: MediaStream | null = null;
  const captures = new Map<number, MediaStream>();
  // Default to a full-panel target until the receiver's first measured hint
  // arrives; the cap below keeps this from over-encoding on connect.
  let currentTarget: ResTarget = { w: 3840, h: 2160 };
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Re-registration timer used to recover from a transient room-full (see below).
  let roomFullTimer: ReturnType<typeof setTimeout> | null = null;

  // Persist our assigned slot per-room in sessionStorage so a reload reclaims
  // the *same* identity (sent as `prefer`, which the hub honors by reclaiming
  // the slot from our own ghost socket). sessionStorage is per-tab and survives
  // reload but not a fresh tab, so reopening never bumps another live device.
  const slotKey = `slot:${room}`;
  const savedSlot = (): DeviceId | null => {
    const s = sessionStorage.getItem(slotKey);
    return isDeviceId(s) ? s : null;
  };

  // Our per-tab token, sent with every register so the hub only ever lets us
  // reclaim a slot from our *own* ghost — never evict a different live device
  // that happens to hold (or also prefer) the same slot. Without it, two tabs
  // both preferring device-a evict each other every 3s in an endless reconnect
  // loop. Per-tab (sessionStorage) so reopening in a new tab doesn't bump it.
  const token = clientToken(sessionStorage);

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

  // Signaling/registration phase, shown with precedence over the media view
  // below; null once assigned, when the controller's derived view takes over.
  type SignalingPhase = "joining" | "room-full" | "server-down" | null;
  let signalingPhase: SignalingPhase = "joining";

  // The pure media-lifecycle controller (capture acquire / hot-swap / renegotiate
  // / teardown). The adapter feeds it events and applies its actions; senderView
  // derives status + favicon from its state.
  let ctl: SenderControllerState = initialControllerState;

  // Single render path. Signaling phases (joining / room-full / server-down) win;
  // otherwise the controller's derived view drives status, with the assigned-idle
  // hint as the one adapter-owned fallback. Favicon always follows the view.
  function render(): void {
    const view = senderView(ctl);
    if (signalingPhase === "server-down") {
      setStatus("Server disconnected — retrying in 3s…", "error");
    } else if (signalingPhase === "room-full") {
      setStatus("Two devices are already sharing to this screen — waiting for a free slot…");
    } else if (signalingPhase === "joining") {
      setStatus("Joining…");
    } else if (view.status) {
      setStatus(view.status, view.cls);
    } else {
      setStatus("Connected to server — waiting for TV receiver…");
    }
    setFavicon(FAVICON[view.favicon]);
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
      statsEl.textContent = `${myId || "…"} · ${quality.name}\nnot connected`;
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
      `${myId || "…"} · ${quality.name} (cap ${activeCapHeight}p)\n` +
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

  // ── Negotiation: pure reducer + thin adapter ────────────────────────────
  // All offer/answer/ICE decisions live in senderReduce (pure, unit-tested).
  // This adapter performs the real RTCPeerConnection I/O and feeds results back
  // as events. currentEpoch is the live PC generation: every async result and
  // every PC handler is checked against it so a superseded negotiation (a newer
  // offer-trigger fired first) can't drive status, retry, or apply to a dead PC.
  let senderSession: SenderState = initialSenderState;
  let currentEpoch = 0;

  function dispatch(event: SenderEvent): void {
    const { state, actions } = senderReduce(senderSession, event);
    senderSession = state;
    for (const action of actions) applySender(action);
  }

  function applySender(action: SenderAction): void {
    switch (action.t) {
      case "create-pc": {
        currentEpoch = action.epoch;
        const epoch = action.epoch;
        pc?.close();
        pc = new RTCPeerConnection(STUN);
        resetAdaptBaseline();
        for (const track of stream!.getTracks()) pc.addTrack(track, stream!);

        pc.onicecandidate = ({ candidate }) => {
          if (candidate && myId)
            ws?.send(
              JSON.stringify({ type: "ice-candidate", to: "receiver", from: myId, candidate }),
            );
        };

        pc.onconnectionstatechange = () => {
          if (epoch !== currentEpoch) return; // a superseded PC — ignore it
          const state = pc?.connectionState;
          // Feed the controller; it owns retry/status. Only connecting/connected/
          // failed are meaningful — `disconnected` is a transient ICE blip that
          // self-heals (forwarding it as failed re-creates the gray-screen retry),
          // and `closed` is our own teardown.
          if (state === "connected") {
            dispatchCtl({ t: "connection-changed", phase: "connected" });
            void applyTarget(currentTarget);
          } else if (state === "connecting") {
            dispatchCtl({ t: "connection-changed", phase: "connecting" });
          } else if (state === "failed") {
            dispatchCtl({ t: "connection-failed" });
          }
        };
        break;
      }
      case "create-offer": {
        if (!pc) break;
        const thePc = pc;
        const epoch = action.epoch;
        thePc
          .createOffer()
          .then(async (offer) => {
            if (epoch !== currentEpoch || pc !== thePc) return; // superseded
            await thePc.setLocalDescription(offer);
            dispatch({ t: "offer-created", epoch, sdp: offer.sdp ?? "" });
          })
          .catch(() => dispatch({ t: "op-failed", epoch, op: "offer" }));
        break;
      }
      case "send-offer": {
        if (myId)
          ws?.send(
            JSON.stringify({ type: "offer", to: "receiver", from: myId, sdp: action.sdp }),
          );
        break;
      }
      case "set-remote": {
        if (action.epoch !== currentEpoch || !pc) break;
        pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: action.sdp }))
          .then(() => dispatch({ t: "remote-set", epoch: action.epoch }))
          .catch(() => dispatch({ t: "op-failed", epoch: action.epoch, op: "remote" }));
        break;
      }
      case "add-ice": {
        if (action.epoch !== currentEpoch || !pc) break;
        // A single rejected candidate must not tear the session down — swallow it.
        pc.addIceCandidate(new RTCIceCandidate(action.candidate)).catch(() => {});
        break;
      }
      case "close-pc": {
        pc?.close();
        pc = null;
        break;
      }
    }
  }

  // ── Media lifecycle: pure controller + thin adapter ─────────────────────────
  // The controller owns the *policy* (acquire / hot-swap / renegotiate / teardown);
  // the negotiation reducer above is the *mechanism* it drives via `renegotiate`
  // and `teardown-peer`. Every action result re-renders the derived view.
  function dispatchCtl(event: SenderControllerEvent): void {
    const { state, actions } = senderControllerReduce(ctl, event);
    ctl = state;
    for (const action of actions) applyCtl(action);
    render();
  }

  function applyCtl(action: SenderControllerAction): void {
    switch (action.t) {
      case "acquire-capture":
        void acquireCapture(action.gen);
        break;
      case "use-capture":
        // The sole writer of the stream `create-pc` reads. Emitted immediately
        // before `renegotiate`, so the next PC is built from this capture.
        stream = captures.get(action.gen) ?? null;
        break;
      case "attach-preview":
        attachPreview(action.gen);
        break;
      case "swap-tracks":
        void swapTracks(action.gen, action.retireGen);
        break;
      case "stop-capture":
        stopCapture(action.gen);
        break;
      case "renegotiate":
        dispatch({ t: "offer-trigger" });
        break;
      case "teardown-peer":
        dispatch({ t: "peer-gone" });
        break;
      case "schedule-retry":
        if (!retryTimer)
          retryTimer = setTimeout(() => {
            retryTimer = null;
            dispatchCtl({ t: "retry-fired" });
          }, 3000);
        break;
      case "cancel-retry":
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        break;
    }
  }

  async function acquireCapture(gen: number): Promise<void> {
    try {
      const captured = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // Capture at native (up to 4K) so a focused stream on a 4K panel can be
          // genuinely sharp. Capture resolution doesn't affect latency, and
          // pip/side panes are downscaled per the receiver's measured target, so
          // this costs nothing until a stream is actually focused.
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
      captures.set(gen, captured);
      captured.getVideoTracks().forEach((t) => {
        t.contentHint = "detail";
      });
      dispatchCtl({ t: "capture-acquired", gen, hasAudio: captured.getAudioTracks().length > 0 });
    } catch (err) {
      captures.delete(gen);
      dispatchCtl({ t: "capture-failed", gen });
      // Cancelling a *re-share* picker leaves the live capture untouched (the
      // controller didn't clear it), so don't shout an error over a working
      // share — only surface a failure when nothing is streaming.
      if (!ctl.capture) setStatus(`Could not start screen share: ${(err as Error).message}`, "error");
    }
  }

  function attachPreview(gen: number): void {
    const captured = captures.get(gen);
    if (!captured) return;
    preview.srcObject = captured;
    preview.classList.add("visible");
    shareBtn.textContent = "Re-share Screen";
    // Gen-tagged: the controller drops a stale capture's `ended` (one superseded
    // by a re-share), so this can't tear down the live share. Only attached
    // captures get a handler; superseded ones are simply stopped.
    const video = captured.getVideoTracks()[0];
    if (video) video.onended = () => dispatchCtl({ t: "capture-ended", gen });
  }

  async function swapTracks(gen: number, retireGen: number): Promise<void> {
    const captured = captures.get(gen);
    if (!pc || !captured) return;
    const newVideo = captured.getVideoTracks()[0] ?? null;
    const newAudio = captured.getAudioTracks()[0] ?? null;
    for (const sender of pc.getSenders()) {
      const kind = sender.track?.kind;
      if (kind === "video" && newVideo) await sender.replaceTrack(newVideo);
      else if (kind === "audio" && newAudio) await sender.replaceTrack(newAudio);
    }
    void applyTarget(currentTarget);
    // Retire the old capture only after the swap, so the outbound stream never
    // goes dark in the gap.
    stopCapture(retireGen);
  }

  function stopCapture(gen: number): void {
    const captured = captures.get(gen);
    if (!captured) return;
    for (const t of captured.getTracks()) {
      t.onended = null;
      t.stop();
    }
    captures.delete(gen);
  }

  // Register as a sender; the hub assigns a slot and replies `assigned`. Prefer
  // our current slot across reconnects, a reload's saved slot, or a ?id= hint —
  // so we reclaim the same identity (and the hub evicts our own ghost) rather
  // than hopping A↔B or being blocked by it.
  function sendRegister(): void {
    ws?.send(
      JSON.stringify({
        type: "register",
        role: "sender",
        prefer: myId || savedSlot() || preferId,
        token,
      }),
    );
  }

  function connectWS(): void {
    const sock = new WebSocket(signalingUrl(room));
    ws = sock;

    // Detect a half-open socket and reconnect at once, rather than sitting frozen
    // on a connection whose close may never fire (the "stuck, no Share button"
    // case). startHeartbeat tears the dead socket down; we just reopen if it's
    // still the current one. Re-registering reclaims our slot from the ghost.
    const hb = startHeartbeat(sock, () => {
      if (ws === sock) {
        ws = null;
        connectWS();
      }
    });

    sock.onopen = () => {
      sendRegister();
      signalingPhase = "joining";
      render();
    };

    sock.onmessage = (e: MessageEvent<string>) => {
      hb.alive();
      let msg: SenderInMsg;
      try {
        msg = JSON.parse(e.data) as SenderInMsg;
      } catch {
        return;
      }

      if (msg.type === "assigned") {
        myId = msg.id;
        sessionStorage.setItem(slotKey, msg.id);
        if (roomFullTimer) {
          clearTimeout(roomFullTimer);
          roomFullTimer = null;
        }
        showAssigned(msg.id);
        shareBtn.disabled = false;
        signalingPhase = null; // hand the status over to the media view
        render();
      }
      if (msg.type === "room-full") {
        // Don't treat this as terminal: a slot can be momentarily occupied by a
        // ghost (a peer mid-reload, or a half-open socket the hub's heartbeat
        // hasn't reaped yet). Keep re-registering so we slot in as soon as one
        // frees, instead of wedging here with no Share button forever.
        myId = "";
        shareBtn.disabled = true;
        signalingPhase = "room-full";
        render();
        if (!roomFullTimer) {
          roomFullTimer = setTimeout(() => {
            roomFullTimer = null;
            sendRegister();
          }, 3000);
        }
      }
      if (msg.type === "receiver-ready") {
        dispatchCtl({ t: "receiver-ready" });
      }
      if (msg.type === "answer") {
        dispatch({ t: "answer", sdp: msg.sdp });
      }
      if (msg.type === "ice-candidate" && msg.candidate) {
        dispatch({ t: "ice", candidate: msg.candidate });
      }
      if (msg.type === "peer-disconnected") {
        dispatchCtl({ t: "receiver-gone" });
      }
      if (msg.type === "request-reoffers") {
        dispatchCtl({ t: "reoffer-requested" });
      }
      if (msg.type === "res-hint") {
        void applyTarget(msg.target);
      }
    };

    sock.onclose = () => {
      hb.stop();
      ws = null;
      if (roomFullTimer) {
        clearTimeout(roomFullTimer);
        roomFullTimer = null;
      }
      shareBtn.disabled = true;
      signalingPhase = "server-down";
      // socket-down only clears receiverReady — it keeps the capture + peer
      // connection alive, since media is P2P and keeps flowing to the TV while
      // signaling is down. We re-offer when the receiver re-announces on reconnect.
      dispatchCtl({ t: "socket-down" });
      setTimeout(connectWS, 3000);
    };
  }

  // Share / Re-share. All the capture lifecycle (acquire, hot-swap vs renegotiate,
  // retire the old capture, the gen-tagged stale-end guard) lives in the
  // controller; the click is just the entry event.
  shareBtn.addEventListener("click", () => dispatchCtl({ t: "share-requested" }));

  // Screen capture is unavailable on iOS (every browser is WebKit, which never
  // implemented getDisplayMedia) and on some others like Firefox for Android.
  // Detect it up front so unsupported devices get a clear message instead of a
  // raw "getDisplayMedia is not a function" error after tapping Share Screen.
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
    shareBtn.disabled = true;
    setStatus(
      "This device or browser doesn't support screen sharing. Use a computer (or Android Chrome) as the sender.",
      "error",
    );
    setFavicon(FAVICON.grey);
    return;
  }

  setFavicon(FAVICON.grey);
  connectWS();
}

// ── Room resolution ─────────────────────────────────────────────────────────
// A sender must join a specific TV's room. The QR / join-link from the receiver
// carries ?room=CODE; if it's missing or malformed we ask the user to type the
// code shown on the TV. Only once a valid room is set do we reveal the sender
// card and connect — the hub then assigns this device a slot (A or B) by arrival
// order, so there's nothing to pick. Kept at the end of the module so every
// top-level const (PRESETS, etc.) is initialized before startSender() runs.
// (`params` is the single module-level URLSearchParams declared up top.)

function proceed(): void {
  (document.getElementById("mainScreen") as HTMLElement).style.display = "flex";
  startSender();
}

const urlCode = coerceRoomCode(params.get("room"));
if (urlCode) {
  room = urlCode;
  proceed();
} else if (signalingHost() === null) {
  // No hub configured ⇒ the local server.ts is a single global hub that ignores
  // room codes, so skip the join step and keep the original `pnpm start` flow.
  proceed();
} else {
  // A hosted (multi-tenant) hub needs a room to target. Ask for the join code,
  // hiding the picker until we have one.
  const joinScreen = document.getElementById("joinScreen") as HTMLElement;
  joinScreen.style.display = "flex";
  const input = document.getElementById("roomInput") as HTMLInputElement;
  const joinBtn = document.getElementById("roomJoin") as HTMLButtonElement;
  const joinError = document.getElementById("joinError") as HTMLElement;

  const submit = (): void => {
    const code = coerceRoomCode(input.value);
    if (!code) {
      joinError.textContent = "Enter the code shown on the TV.";
      return;
    }
    room = code;
    // Keep the code on a reload (and for the ?id= auto-start path).
    persistRoomInUrl(code);
    joinScreen.style.display = "none";
    proceed();
  };

  joinBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  input.focus();
}
