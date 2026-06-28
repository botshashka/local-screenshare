import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  signalingUrl,
  isValidRoomCode,
  normalizeRoomCode,
  coerceRoomCode,
  generateRoomCode,
  ROOM_ALPHABET,
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

  it("honors an explicit scheme on the hub and strips trailing slashes", () => {
    expect(signalingUrl(ROOM, "ws://x.test")).toBe("ws://x.test/ws?room=ABC234");
    expect(signalingUrl(ROOM, "http://x.test:8080")).toBe("ws://x.test:8080/ws?room=ABC234");
    expect(signalingUrl(ROOM, "https://x.test/")).toBe("wss://x.test/ws?room=ABC234");
    expect(signalingUrl(ROOM, "wss://x.test")).toBe("wss://x.test/ws?room=ABC234");
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
});
