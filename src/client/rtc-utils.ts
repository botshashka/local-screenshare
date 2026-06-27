export const STUN: RTCConfiguration = { iceServers: [] };

export const SENDER_IDS = ["device-a", "device-b"] as const;
export type DeviceId = (typeof SENDER_IDS)[number];

export const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// Target on-screen size of a stream's pane, in device pixels — the receiver
// measures its slots and sends this; the sender encodes to match (never
// upscaling past capture, never exceeding its own 1440p cap). Encoding to the
// displayed size, rather than a fixed tier, keeps total encoded pixels ≈ the
// TV panel regardless of how many devices are connected.
export type ResTarget = { w: number; h: number };

export type SenderInMsg =
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
  | { type: "peer-disconnected"; id: string };

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
