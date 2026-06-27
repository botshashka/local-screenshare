import { wsUrl, tweakSdp, type ResHint, type SenderInMsg } from "./rtc-utils.js";

type StatusClass = "" | "connected" | "error";

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

const paramId = new URLSearchParams(location.search).get("id");
if (paramId) init(paramId);

function init(id: string): void {
  (document.getElementById("pickerScreen") as HTMLElement).style.display = "none";
  const main = document.getElementById("mainScreen") as HTMLElement;
  main.style.display = "flex";
  (document.getElementById("idBadge") as HTMLElement).textContent = id;
  document.title = `Sender: ${id}`;
  startSender(id);
}

(document.getElementById("btnA") as HTMLButtonElement).addEventListener("click", () =>
  init("device-a"),
);
(document.getElementById("btnB") as HTMLButtonElement).addEventListener("click", () =>
  init("device-b"),
);

function startSender(id: string): void {
  let pc: RTCPeerConnection | null = null;
  let ws: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let receiverReady = false;
  let currentHint: ResHint = "full";
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const TIERS: Record<ResHint, { scaleResolutionDownBy: number; maxBitrate: number }> = {
    full: { scaleResolutionDownBy: 1, maxBitrate: 6_000_000 },
    side: { scaleResolutionDownBy: 1, maxBitrate: 3_000_000 },
    pip: { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  };

  const statusEl = document.getElementById("status") as HTMLElement;
  const shareBtn = document.getElementById("shareBtn") as HTMLButtonElement;
  const preview = document.getElementById("preview") as HTMLVideoElement;

  function setStatus(msg: string, cls: StatusClass = ""): void {
    statusEl.textContent = msg;
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

  async function applyHint(hint: ResHint): Promise<void> {
    currentHint = hint;
    if (!pc || pc.connectionState !== "connected") return;
    const tier = TIERS[hint];
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const params = sender.getParameters();
      if (!params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      if (!enc) continue;
      enc.networkPriority = "high";
      enc.priority = "high";
      enc.maxBitrate = tier.maxBitrate;
      enc.scaleResolutionDownBy = tier.scaleResolutionDownBy;
      await sender.setParameters(params).catch(() => {});
    }
  }

  async function makeOffer(): Promise<void> {
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: [] });

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
        await applyHint(currentHint);
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
        await applyHint(msg.hint);
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
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
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
