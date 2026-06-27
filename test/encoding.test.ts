import { describe, it, expect } from "vitest";
import {
  computeEncoding,
  resolvePresetName,
  defaultPresetForCores,
  adaptStep,
  tweakSdp,
} from "../src/client/rtc-utils";

const CAP_4K = { w: 3840, h: 2160 };
const ENC = { bpp: 0.1, fps: 30, minBitrate: 300_000, maxBitrate: 25_000_000 };

describe("computeEncoding", () => {
  // 4K source, focused on a 4K pane, 4K cap → encode full 4K, no downscale.
  it("encodes full 4K when source, pane and cap all allow it", () => {
    const e = computeEncoding({ capW: 3840, capH: 2160, target: CAP_4K, capHeight: 2160, ...ENC });
    expect(e.scale).toBe(1);
    expect([e.width, e.height]).toEqual([3840, 2160]);
    expect(e.bitrate).toBe(Math.round(3840 * 2160 * 30 * 0.1));
  });

  // A side-by-side half-width pane downscales to its displayed size (1080p),
  // even though the source and cap would allow more — no wasted pixels.
  it("downscales to the displayed pane size", () => {
    const e = computeEncoding({ capW: 3840, capH: 2160, target: { w: 1920, h: 2160 }, capHeight: 2160, ...ENC });
    expect(e.scale).toBe(2);
    expect([e.width, e.height]).toEqual([1920, 1080]);
  });

  // The height cap bites for a focused 4K pane when the preset is 1440p.
  it("honors the height cap below the pane size", () => {
    const e = computeEncoding({ capW: 3840, capH: 2160, target: CAP_4K, capHeight: 1440, ...ENC });
    expect(e.scale).toBe(1.5);
    expect([e.width, e.height]).toEqual([2560, 1440]);
  });

  // A 1080p source is never upscaled to a 4K pane / 4K cap (scale stays 1).
  it("never upscales past the captured source", () => {
    const e = computeEncoding({ capW: 1920, capH: 1080, target: CAP_4K, capHeight: 2160, ...ENC });
    expect(e.scale).toBe(1);
    expect([e.width, e.height]).toEqual([1920, 1080]);
  });

  it("clamps bitrate to the floor for a tiny pane", () => {
    const e = computeEncoding({ capW: 1920, capH: 1080, target: { w: 100, h: 100 }, capHeight: 2160, ...ENC });
    expect(e.bitrate).toBe(300_000);
  });

  it("clamps bitrate to the ceiling", () => {
    const e = computeEncoding({ ...ENC, capW: 3840, capH: 2160, target: CAP_4K, capHeight: 2160, maxBitrate: 10_000_000 });
    expect(e.bitrate).toBe(10_000_000);
  });
});

describe("defaultPresetForCores", () => {
  it("maps core count to a preset", () => {
    expect(defaultPresetForCores(4)).toBe("performance");
    expect(defaultPresetForCores(5)).toBe("performance");
    expect(defaultPresetForCores(6)).toBe("balanced");
    expect(defaultPresetForCores(9)).toBe("balanced");
    expect(defaultPresetForCores(10)).toBe("maximum");
    expect(defaultPresetForCores(16)).toBe("maximum");
  });
});

describe("resolvePresetName", () => {
  it("prefers a valid URL param over everything", () => {
    expect(resolvePresetName("balanced", "maximum", 16)).toBe("balanced");
  });
  it("falls back to a saved choice when no URL param", () => {
    expect(resolvePresetName(null, "maximum", 4)).toBe("maximum");
  });
  it("falls back to the core default when neither is set", () => {
    expect(resolvePresetName(null, null, 4)).toBe("performance");
    expect(resolvePresetName(null, null, 12)).toBe("maximum");
  });
  it("ignores unknown values at either slot", () => {
    expect(resolvePresetName("bogus", "balanced", 16)).toBe("balanced");
    expect(resolvePresetName("bogus", "nonsense", 12)).toBe("maximum");
  });
});

describe("adaptStep", () => {
  const CEIL = 3;

  it("drops a rung only after two strained intervals (hysteresis)", () => {
    const s1 = adaptStep({ rung: 3, strain: 0, comfort: 0 }, 0.5, CEIL);
    expect(s1).toEqual({ rung: 3, strain: 1, comfort: 0 });
    const s2 = adaptStep(s1, 0.5, CEIL);
    expect(s2).toEqual({ rung: 2, strain: 0, comfort: 0 });
  });

  it("climbs a rung only after four comfortable intervals", () => {
    let s = { rung: 1, strain: 0, comfort: 0 };
    for (let i = 0; i < 3; i++) s = adaptStep(s, 0, CEIL);
    expect(s).toEqual({ rung: 1, strain: 0, comfort: 3 });
    s = adaptStep(s, 0, CEIL);
    expect(s).toEqual({ rung: 2, strain: 0, comfort: 0 });
  });

  it("never drops below the floor", () => {
    const s = adaptStep({ rung: 0, strain: 1, comfort: 0 }, 0.5, CEIL);
    expect(s.rung).toBe(0);
  });

  it("never climbs above the ceiling", () => {
    const s = adaptStep({ rung: CEIL, strain: 0, comfort: 3 }, 0, CEIL);
    expect(s.rung).toBe(CEIL);
  });

  it("a strained interval resets accumulated comfort and vice versa", () => {
    expect(adaptStep({ rung: 2, strain: 0, comfort: 3 }, 0.5, CEIL)).toEqual({
      rung: 2,
      strain: 1,
      comfort: 0,
    });
    expect(adaptStep({ rung: 2, strain: 1, comfort: 0 }, 0, CEIL)).toEqual({
      rung: 2,
      strain: 0,
      comfort: 1,
    });
  });
});

describe("tweakSdp", () => {
  const sdp = [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 98 100",
    "a=rtpmap:96 H264/90000",
    "a=rtpmap:98 VP9/90000",
    "a=rtpmap:100 VP9/90000",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
  ].join("\r\n");

  it("promotes VP9 payload types to the front of the m=video line", () => {
    expect(tweakSdp(sdp)).toContain("m=video 9 UDP/TLS/RTP/SAVPF 98 100 96");
  });

  it("rewrites the opus fmtp for stereo, high-bitrate audio", () => {
    const out = tweakSdp(sdp);
    expect(out).toContain("stereo=1;sprop-stereo=1");
    expect(out).toContain("maxaveragebitrate=510000");
  });

  it("adds the bandwidth hint only when requested", () => {
    expect(tweakSdp(sdp)).not.toContain("b=AS:6000");
    expect(tweakSdp(sdp, true)).toContain("b=AS:6000");
  });

  it("leaves a VP9-less m=video line untouched", () => {
    const noVp9 = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000";
    expect(tweakSdp(noVp9)).toContain("m=video 9 UDP/TLS/RTP/SAVPF 96");
  });
});
