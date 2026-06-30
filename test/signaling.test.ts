import { describe, it, expect, afterEach } from "vitest";
import {
  signalingUrl,
  signalingHost,
  isValidRoomCode,
  normalizeRoomCode,
  coerceRoomCode,
  generateRoomCode,
  ROOM_ALPHABET,
  SENDER_IDS,
  HB_INTERVAL_MS,
  HB_TIMEOUT_MS,
} from "../src/client/rtc-utils";
import * as core from "../src/core/room";

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
  it("accepts well-formed 4-char codes case-insensitively", () => {
    expect(isValidRoomCode("K7P3")).toBe(true);
    expect(isValidRoomCode("k7p3")).toBe(true);
  });

  it("rejects ambiguous chars, wrong length, and nullish input", () => {
    expect(isValidRoomCode("0O1I")).toBe(false); // 0 O 1 I are not in the alphabet
    expect(isValidRoomCode("ABC")).toBe(false); // 3 chars — only exactly 4 is valid
    expect(isValidRoomCode("ABCD2")).toBe(false); // 5 chars
    expect(isValidRoomCode("")).toBe(false);
    expect(isValidRoomCode(null)).toBe(false);
    expect(isValidRoomCode(undefined)).toBe(false);
  });

  it("normalizes by trimming and upper-casing", () => {
    expect(normalizeRoomCode("  k7p3  ")).toBe("K7P3");
  });

  it("coerces a valid candidate to a normalized code, else null", () => {
    expect(coerceRoomCode("  k7p3 ")).toBe("K7P3");
    expect(coerceRoomCode("nope")).toBeNull(); // O is not in the alphabet
    expect(coerceRoomCode(null)).toBeNull();
    // Enables flat fallback resolution.
    expect(coerceRoomCode("bad") ?? coerceRoomCode("K7P3") ?? "gen").toBe("K7P3");
  });

  it("generates valid 4-char codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(4);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) expect(ROOM_ALPHABET).toContain(ch);
    }
  });

  it("keeps the shared hub core's constants in sync with the client (drift guard)", () => {
    // src/core/room.ts is the single source the two hub runtimes import. The client
    // can't import it (its build is rooted at src/client), so it keeps a mirror —
    // this guards the mirror against the core so room codes, slot ids, and the
    // heartbeat windows can never disagree between the pages and the hub.
    expect(core.ROOM_ALPHABET).toBe(ROOM_ALPHABET);
    expect([...core.SENDER_IDS]).toEqual([...SENDER_IDS]);
    expect(core.HB_INTERVAL_MS).toBe(HB_INTERVAL_MS);
    expect(core.HB_TIMEOUT_MS).toBe(HB_TIMEOUT_MS);
    // The core's regex must accept exactly what the client validator does.
    const ok = generateRoomCode();
    expect(core.ROOM_RE.test(ok)).toBe(isValidRoomCode(ok));
    expect(core.ROOM_RE.test("short")).toBe(false);
    expect(core.ROOM_RE.test("0000")).toBe(false); // ambiguous chars excluded
  });
});
