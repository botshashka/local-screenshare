export const STUN: RTCConfiguration = { iceServers: [] };

export const SENDER_IDS = ["device-a", "device-b"] as const;
export type DeviceId = (typeof SENDER_IDS)[number];

export const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

export type ResHint = "full" | "side" | "pip";

export type SenderInMsg =
  | { type: "receiver-ready" }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "peer-disconnected" }
  | { type: "request-reoffers" }
  | { type: "res-hint"; hint: ResHint };

export type ReceiverInMsg =
  | { type: "sender-connected"; id: string }
  | { type: "offer"; from: string; sdp: string }
  | { type: "ice-candidate"; from: string; candidate: RTCIceCandidateInit }
  | { type: "peer-disconnected"; id: string };

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
