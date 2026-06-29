import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  signalingUrl,
  signalingHost,
  isValidRoomCode,
  normalizeRoomCode,
  coerceRoomCode,
  generateRoomCode,
  ROOM_ALPHABET,
  SENDER_IDS,
} from "../src/client/rtc-utils";

describe("signalingUrl", () => {
  const ROOM = "ABC234";

  it("uses wss for a bare hub host (assumed TLS)", () => {
    expect(signalingUrl(ROOM, "hub.example.com")).toBe("wss://hub.example.com/ws?room=ABC234");
  });

  it("uses ws for a localhost hub (local dev)", () => {
    expect(signalingUrl(ROOM, "localhost:4242")).toBe("ws://localhost:4242/ws?room=ABC234");
    expect(signalingUrl(ROOM, "127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws?room=ABC234");
  });

  it("uses ws for a bare LAN IPv4 hub (no public TLS cert possible)", () => {
    expect(signalingUrl(ROOM, "192.168.1.50:8787")).toBe(
      "ws://192.168.1.50:8787/ws?room=ABC234",
    );
  });

  it("honors an explicit scheme on the hub and strips trailing slashes", () => {
    expect(signalingUrl(ROOM, "ws://x.test")).toBe("ws://x.test/ws?room=ABC234");
    expect(signalingUrl(ROOM, "http://x.test:8080")).toBe("ws://x.test:8080/ws?room=ABC234");
    expect(signalingUrl(ROOM, "https://x.test/")).toBe("wss://x.test/ws?room=ABC234");
    expect(signalingUrl(ROOM, "wss://x.test")).toBe("wss://x.test/ws?room=ABC234");
  });

  it("strips a path from the hub host so /ws isn't doubled", () => {
    expect(signalingUrl(ROOM, "wss://x.test/ws")).toBe("wss://x.test/ws?room=ABC234");
    expect(signalingUrl(ROOM, "x.test/ws")).toBe("wss://x.test/ws?room=ABC234");
    expect(signalingUrl(ROOM, "x.test/some/path")).toBe("wss://x.test/ws?room=ABC234");
  });

  it("falls back to the page origin when no hub is configured", () => {
    // happy-dom serves the test page over http://localhost — mirror that.
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    expect(signalingUrl(ROOM, null)).toBe(`${scheme}://${location.host}/ws?room=ABC234`);
  });

  it("url-encodes the room code", () => {
    expect(signalingUrl("AB CD", "h.test")).toBe("wss://h.test/ws?room=AB%20CD");
  });
});

describe("signalingHost precedence", () => {
  type WithHub = typeof globalThis & { __SIGNALING_HUB__?: unknown };

  afterEach(() => {
    delete (globalThis as WithHub).__SIGNALING_HUB__;
    document.querySelector('meta[name="signaling-hub"]')?.remove();
    history.replaceState(null, "", "/");
  });

  function setMeta(content: string): void {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "signaling-hub");
    meta.setAttribute("content", content);
    document.head.appendChild(meta);
  }

  it("returns null when nothing is configured", () => {
    expect(signalingHost()).toBeNull();
  });

  it("reads the injected global, then the meta, then null", () => {
    setMeta("meta.example");
    expect(signalingHost()).toBe("meta.example");
    (globalThis as WithHub).__SIGNALING_HUB__ = "global.example";
    expect(signalingHost()).toBe("global.example"); // global outranks meta
  });

  it("the ?hub= param outranks the injected global", () => {
    (globalThis as WithHub).__SIGNALING_HUB__ = "global.example";
    history.replaceState(null, "", "/?hub=param.example");
    expect(signalingHost()).toBe("param.example");
  });

  it("ignores blank/whitespace values and trims", () => {
    setMeta("   ");
    expect(signalingHost()).toBeNull(); // whitespace-only meta is not a host
    (globalThis as WithHub).__SIGNALING_HUB__ = "  trimmed.example  ";
    expect(signalingHost()).toBe("trimmed.example");
  });
});

describe("room codes", () => {
  it("accepts well-formed 8-char codes case-insensitively", () => {
    expect(isValidRoomCode("ABCD2345")).toBe(true);
    expect(isValidRoomCode("k7p2q9ab")).toBe(true);
  });

  it("rejects ambiguous chars, wrong length, and nullish input", () => {
    expect(isValidRoomCode("ABCD0O1I")).toBe(false); // 0 O 1 I are not in the alphabet
    expect(isValidRoomCode("ABC234")).toBe(false); // 6 chars — only exactly 8 is valid
    expect(isValidRoomCode("ABCD23456")).toBe(false); // 9 chars
    expect(isValidRoomCode("")).toBe(false);
    expect(isValidRoomCode(null)).toBe(false);
    expect(isValidRoomCode(undefined)).toBe(false);
  });

  it("normalizes by trimming and upper-casing", () => {
    expect(normalizeRoomCode("  abcd2345  ")).toBe("ABCD2345");
  });

  it("coerces a valid candidate to a normalized code, else null", () => {
    expect(coerceRoomCode("  abcd2345 ")).toBe("ABCD2345");
    expect(coerceRoomCode("nope")).toBeNull();
    expect(coerceRoomCode(null)).toBeNull();
    // Enables flat fallback resolution.
    expect(coerceRoomCode("bad") ?? coerceRoomCode("ABCD2345") ?? "gen").toBe("ABCD2345");
  });

  it("generates valid 8-char codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(8);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) expect(ROOM_ALPHABET).toContain(ch);
    }
  });

  it("keeps the Worker's room-code regex in sync with the client (drift guard)", () => {
    // The Worker hub holds its own copy of the room-code pattern. If the alphabet
    // or length here ever changes, this trips so the two can't silently diverge.
    const workerSrc = readFileSync("worker/src/signaling.ts", "utf8");
    expect(workerSrc).toContain(`[${ROOM_ALPHABET}]{8}`);
  });

  it("keeps the Worker's sender ids in sync with the client (drift guard)", () => {
    // The Worker duplicates SENDER_IDS inline; guard the two slot names so a
    // rename here can't silently leave the Worker assigning stale ids.
    const workerSrc = readFileSync("worker/src/signaling.ts", "utf8");
    for (const id of SENDER_IDS) expect(workerSrc).toContain(`"${id}"`);
  });
});
