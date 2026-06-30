// STUN lets ICE gather server-reflexive candidates so the handshake works when
// the static pages are served from a remote origin rather than the LAN itself.
// We run *no* TURN by design: same-LAN peers connect directly via host/mDNS
// candidates and media never leaves the network — a relay-hostile network simply
// fails to connect rather than routing video through the cloud. (Two public STUN
// servers for redundancy; swap in your own if you prefer not to depend on them.)
export const STUN: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
};

export const SENDER_IDS = ["device-a", "device-b"] as const;
export type DeviceId = (typeof SENDER_IDS)[number];

export function isDeviceId(id: string | null | undefined): id is DeviceId {
  return id != null && (SENDER_IDS as readonly string[]).includes(id);
}

// ── Signaling endpoint resolution ──────────────────────────────────────────
// The static client may be served from a different origin than the signaling
// hub (e.g. the pages on a static host/CDN, the hub on a separate box or a
// serverless function). Resolve the hub host with precedence:
//   ?hub= query param  >  window.__SIGNALING_HUB__  >  <meta>  >  the page's origin.
// __SIGNALING_HUB__ is baked at build time from the SIGNALING_HUB env var (see
// scripts/inject-hub.mjs) so a deploy can set the host without committing it; the
// <meta> is a no-build alternative; the same-origin fallback keeps the local
// `server.ts` (LAN / offline) working unchanged with nothing configured.
export function signalingHost(): string | null {
  const fromParam = new URLSearchParams(location.search).get("hub");
  if (fromParam && fromParam.trim()) return fromParam.trim();
  const injected = (globalThis as { __SIGNALING_HUB__?: unknown }).__SIGNALING_HUB__;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  const meta = document.querySelector('meta[name="signaling-hub"]')?.getAttribute("content");
  if (meta && meta.trim()) return meta.trim();
  return null;
}

// A localhost or LAN/raw-IPv4 host can't present a public TLS cert, so a hub
// given as one is assumed plain ws:// (local dev). Anything else (a domain) is
// assumed wss. An explicit scheme on the host always wins over this guess.
function isLocalOrLanHost(hostPort: string): boolean {
  const host = hostPort.replace(/:\d+$/, "");
  return host === "localhost" || host === "[::1]" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

// Build the signaling WebSocket URL for a room. A configured hub is assumed to
// be TLS (wss) unless it carries an explicit ws/http scheme or is a localhost /
// LAN host (local dev); the same-origin fallback mirrors the page's own
// protocol. `host` is injectable for testing.
export function signalingUrl(roomId: string, host: string | null = signalingHost()): string {
  const query = `?room=${encodeURIComponent(roomId)}`;
  if (!host) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}/ws${query}`;
  }
  let scheme = "wss";
  let bare = host;
  const withScheme = host.match(/^(wss?|https?):\/\/(.+)$/i);
  if (withScheme) {
    const proto = withScheme[1]!.toLowerCase();
    scheme = proto === "http" || proto === "ws" ? "ws" : "wss";
    bare = withScheme[2]!;
  }
  // Keep only the authority (host:port) — drop any path/query the host carried,
  // so a hub given as e.g. "example.com/ws" doesn't become ".../ws/ws" (the hub
  // serves only "/ws", so the doubled path would 404).
  bare = bare.replace(/[/?#].*$/, "");
  if (!withScheme && isLocalOrLanHost(bare)) scheme = "ws";
  return `${scheme}://${bare}/ws${query}`;
}

// ── Liveness heartbeat ───────────────────────────────────────────────────────
// Both clients send `{type:"ping"}` on this interval; the hub replies `{pong}`
// and reaps any socket silent past the timeout (freeing its sender slot). An
// *application*-level heartbeat is deliberate: a half-open or backgrounded tab
// still answers protocol-level pings at the network layer, so only a message the
// page itself sends proves its JS is alive. Mirrors HB_* in src/hub.ts and the
// Worker. The timeout is 3× the interval so a single dropped ping is harmless.
export const HB_INTERVAL_MS = 10_000;
export const HB_TIMEOUT_MS = 30_000;

// Drive a socket's heartbeat. Sends a ping each interval and, if nothing has
// arrived from the server within the timeout, treats the socket as half-open: it
// stops the heartbeat, tears the dead socket down (nulls its onclose so the
// delayed reconnect path can't also fire, then closes it), and invokes
// onReconnect so the caller opens a fresh socket — rather than waiting on a close
// event a dead connection may never deliver. Call alive() from the socket's
// onmessage and stop() from its onclose.
export function startHeartbeat(
  ws: Pick<WebSocket, "send" | "close" | "onclose">,
  onReconnect: () => void,
): { alive: () => void; stop: () => void } {
  let lastSeen = Date.now();
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    if (Date.now() - lastSeen > HB_TIMEOUT_MS) {
      stop();
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already closing
      }
      onReconnect();
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      // socket already closing — onclose will stop us
    }
  }, HB_INTERVAL_MS);
  return {
    alive: () => {
      lastSeen = Date.now();
    },
    stop,
  };
}

// ── Peer-connection liveness ─────────────────────────────────────────────────
// An RTCPeerConnection's `disconnected` state is a routinely *transient* ICE
// flap: connectivity is momentarily lost but usually self-heals within a few
// seconds with no renegotiation (the same track resumes). Only `failed` is
// terminal. Tearing the slot down on `disconnected` is what makes a 1s network
// blip pop the join/QR card and (worse) leaves a blank video, since a self-heal
// to `connected` doesn't re-fire ontrack. This helper separates the two: it only
// reports a real loss on `failed`, or on a `disconnected` that persists past a
// grace window. Modeled on startHeartbeat (pure timer logic, easily unit-tested).
export const DISCONNECT_GRACE_MS = 6000;

// Feed pc.connectionState to update() on every change. onLost fires at most once
// (until stop()) when the drop is judged real — the caller then tears down and
// re-offers. Recovery to `connected` before the grace elapses is a no-op.
export function trackConnectionLiveness(opts: { graceMs?: number; onLost: () => void }): {
  update: (state: RTCPeerConnectionState) => void;
  stop: () => void;
} {
  const graceMs = opts.graceMs ?? DISCONNECT_GRACE_MS;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let lost = false;
  const clearGrace = (): void => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };
  const fire = (): void => {
    if (lost) return;
    lost = true;
    clearGrace();
    opts.onLost();
  };
  return {
    update: (state: RTCPeerConnectionState): void => {
      if (state === "connected") {
        clearGrace();
        return;
      }
      if (state === "failed") {
        fire();
        return;
      }
      if (state === "disconnected") {
        // Could still self-heal — wait out the grace window before escalating,
        // unless it's already running.
        if (graceTimer === undefined && !lost) {
          graceTimer = setTimeout(fire, graceMs);
        }
        return;
      }
      // "closed" / "new" / "connecting" — nothing pending to escalate.
      clearGrace();
    },
    stop: (): void => {
      lost = true; // make a post-stop grace fire impossible
      clearGrace();
    },
  };
}

// ── Room codes ─────────────────────────────────────────────────────────────
// The code is NOT the sole access gate: the Worker namespaces each code by the
// client's network (CF-Connecting-IP), so it's only shared among same-LAN devices —
// which lets it stay short (a few chars from an unambiguous alphabet, no 0/1/I/L/O,
// read off a TV, typed, or scanned). Built for small home networks: a convenience
// gate among your own devices, not a boundary against shared/CGNAT egress.
export const ROOM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_LEN = 4;
// Validation length is tied to the generated length: every real code is exactly
// ROOM_LEN chars, so accepting any other length just invites typos. (The Worker
// keeps a copy of this pattern — see test/signaling.test.ts for the drift guard.)
const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_LEN}}$`);

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidRoomCode(code: string | null | undefined): code is string {
  return code != null && ROOM_RE.test(normalizeRoomCode(code));
}

// Normalize a candidate to a valid room code, or null if it isn't one — lets
// callers resolve a code with a flat `coerceRoomCode(a) ?? coerceRoomCode(b)`.
export function coerceRoomCode(code: string | null | undefined): string | null {
  return isValidRoomCode(code) ? normalizeRoomCode(code) : null;
}

// Reflect the active room into the page URL (replacing, not pushing) so a reload
// or a copied address keeps it. No-op if it's already there.
export function persistRoomInUrl(room: string): void {
  const url = new URL(location.href);
  if (url.searchParams.get("room") === room) return;
  url.searchParams.set("room", room);
  history.replaceState(null, "", url);
}

// ~20 bits, scoped per-network by the Worker — on a home LAN only your own devices
// share the space. The modulo over a 31-char alphabet adds negligible bias here.
export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
}

// ── Per-tab identity token ──────────────────────────────────────────────────
// A stable random token identifying this tab to the hub, so a sender reconnect
// can reclaim *its own* slot from a half-open ghost while a different live
// device that also prefers that slot is left alone (the hub compares tokens —
// see the claim rule in src/hub.ts / the Worker). Persisted in sessionStorage
// so it survives a reload but is per-tab: reopening in a new tab gets a fresh
// token and so never bumps another live device. getRandomValues (not
// randomUUID, which needs a secure context) keeps it usable on any origin.
export function clientToken(storage: Storage, key = "clientToken"): string {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  storage.setItem(key, token);
  return token;
}

// Target on-screen size of a stream's pane, in device pixels — the receiver
// measures its slots and sends this; the sender encodes to match (never
// upscaling past capture, never exceeding its own 1440p cap). Encoding to the
// displayed size, rather than a fixed tier, keeps total encoded pixels ≈ the
// TV panel regardless of how many devices are connected.
export type ResTarget = { w: number; h: number };

export type SenderInMsg =
  // The hub assigns a free slot (device-a/device-b) by arrival order; a sender
  // learns its identity from this rather than choosing one. `room-full` means
  // both slots are already held by live senders.
  | { type: "assigned"; id: DeviceId }
  | { type: "room-full" }
  | { type: "receiver-ready" }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "peer-disconnected" }
  | { type: "request-reoffers" }
  | { type: "res-hint"; target: ResTarget };

export type ReceiverInMsg =
  | { type: "sender-connected"; id: string }
  | { type: "offer"; from: string; sdp: string }
  | { type: "ice-candidate"; from: string; candidate: RTCIceCandidateInit }
  | { type: "peer-disconnected"; id: string }
  | { type: "stream-stopped"; from: string };

// ── Quality presets (sender-side encode ceiling) ──────────────────────────
export type QualityPreset = "performance" | "balanced" | "maximum";

// maxHeight caps the encoded frame (the main encode-CPU lever); bpp sets the
// bitrate target (pixels × fps × bpp). Auto-adapt may step *down* from a
// preset's ceiling under CPU strain, but never above it.
export const PRESETS: Record<QualityPreset, { maxHeight: number; bpp: number }> = {
  performance: { maxHeight: 1080, bpp: 0.08 },
  balanced: { maxHeight: 1440, bpp: 0.1 },
  maximum: { maxHeight: 2160, bpp: 0.1 },
};

// Resolution rungs auto-adapt walks between (never above the active preset's
// ceiling, but may drop below its floor under severe strain).
export const HEIGHT_LADDER = [720, 1080, 1440, 2160];

// Each preset ceiling must be a ladder rung — auto-adapt locates it with
// HEIGHT_LADDER.indexOf(maxHeight) and a missing rung would yield -1 (a ceiling
// it can never climb back to). Fail loudly at load if the two ever drift.
for (const { maxHeight } of Object.values(PRESETS)) {
  if (!HEIGHT_LADDER.includes(maxHeight)) {
    throw new Error(`PRESETS height ${maxHeight} is not a HEIGHT_LADDER rung`);
  }
}

export function isPreset(name: string | null | undefined): name is QualityPreset {
  return name != null && name in PRESETS;
}

// Starting preset when the user hasn't chosen one. Core count is a crude proxy
// for encode capability, but it keeps weak machines off 4K by default.
export function defaultPresetForCores(cores: number): QualityPreset {
  if (cores >= 10) return "maximum";
  if (cores >= 6) return "balanced";
  return "performance";
}

// Resolve order: explicit URL param > last saved choice > core-based default.
// An unknown value at either slot is ignored rather than erroring.
export function resolvePresetName(
  urlParam: string | null,
  saved: string | null,
  cores: number,
): QualityPreset {
  if (isPreset(urlParam)) return urlParam;
  if (isPreset(saved)) return saved;
  return defaultPresetForCores(cores);
}

export interface Encoding {
  scale: number;
  bitrate: number;
  width: number;
  height: number;
}

export interface EncodeInput {
  capW: number; // captured source width/height (the upscale ceiling)
  capH: number;
  target: ResTarget; // displayed pane size in device pixels
  capHeight: number; // active encode-height cap (preset, possibly lowered by adapt)
  bpp: number;
  fps: number;
  minBitrate: number;
  maxBitrate: number;
}

// Compute the encoder settings for one stream. Downscale uniformly so the frame
// is no larger than the displayed pane (no wasted pixels) and no taller than the
// active height cap, and never upscale past the captured source (scale ≥ 1).
export function computeEncoding(input: EncodeInput): Encoding {
  const { capW, capH, target, capHeight, bpp, fps, minBitrate, maxBitrate } = input;
  const fitScale = Math.max(capW / target.w, capH / target.h);
  const capScale = capH / capHeight;
  const scale = Math.max(1, fitScale, capScale);
  const width = capW / scale;
  const height = capH / scale;
  const bitrate = Math.round(
    Math.min(maxBitrate, Math.max(minBitrate, width * height * fps * bpp)),
  );
  return { scale, bitrate, width, height };
}

export interface AdaptState {
  rung: number;
  strain: number;
  comfort: number;
}

// Pure one-step decision for the runtime auto-adapt loop. cpuFraction is the
// portion of the last interval the encoder was CPU-limited. Two strained
// intervals in a row drop a rung; four comfortable ones climb one back (but
// never above ceilingRung). The asymmetry + counters are the hysteresis that
// stops a brief spike from yanking resolution.
export function adaptStep(state: AdaptState, cpuFraction: number, ceilingRung: number): AdaptState {
  let { rung, strain, comfort } = state;
  if (cpuFraction > 0.2) {
    strain++;
    comfort = 0;
    if (strain >= 2 && rung > 0) {
      rung--;
      strain = 0;
    }
  } else {
    comfort++;
    strain = 0;
    if (comfort >= 4 && rung < ceilingRung) {
      rung++;
      comfort = 0;
    }
  }
  return { rung, strain, comfort };
}

// addBandwidthHint=true only for offers — b=AS:6000 is set by the offering side.
export function tweakSdp(sdp: string, addBandwidthHint = false): string {
  const vp9Pts = [...sdp.matchAll(/a=rtpmap:(\d+) VP9\/90000/gi)]
    .map((m) => m[1])
    .filter((x): x is string => x !== undefined);

  if (vp9Pts.length) {
    sdp = sdp.replace(/^(m=video \S+ \S+ )([^\r\n]+)/m, (_, header: string, ptList: string) => {
      const pts = ptList.trim().split(" ");
      const reordered = [...vp9Pts, ...pts.filter((p) => !vp9Pts.includes(p))];
      return `${header}${reordered.join(" ")}`;
    });
  }

  if (addBandwidthHint) {
    sdp = sdp.replace(/^(m=video [^\r\n]+)/m, "$1\r\nb=AS:6000");
  }

  const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
  const opusPt = opusMatch?.[1];
  if (opusPt) {
    const fmtp = `a=fmtp:${opusPt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;dtx=0`;
    sdp = sdp.replace(new RegExp(`a=fmtp:${opusPt} [^\r\n]*`), fmtp);
  }

  return sdp;
}
