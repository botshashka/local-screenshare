import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startHeartbeat, HB_INTERVAL_MS, HB_TIMEOUT_MS } from "../src/client/rtc-utils";

// startHeartbeat drives an application-level ping and self-heals a half-open
// socket. Fake timers (which also mock Date.now) let us drive its interval and
// timeout deterministically against a minimal mock socket.
describe("startHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function mockSock() {
    return {
      sent: [] as string[],
      closes: 0,
      onclose: (() => {}) as null | (() => void),
      send(s: string): void {
        this.sent.push(s);
      },
      close(): void {
        this.closes++;
      },
    };
  }

  const PING = JSON.stringify({ type: "ping" });

  it("sends a ping every interval while the socket stays alive", () => {
    const sock = mockSock();
    const hb = startHeartbeat(sock, () => {});
    vi.advanceTimersByTime(HB_INTERVAL_MS);
    expect(sock.sent).toEqual([PING]);
    hb.alive(); // a server frame arrived, resetting the stale clock
    vi.advanceTimersByTime(HB_INTERVAL_MS);
    expect(sock.sent).toEqual([PING, PING]);
    hb.stop();
  });

  it("alive() keeps a busy socket from ever going stale", () => {
    const sock = mockSock();
    let reconnects = 0;
    const hb = startHeartbeat(sock, () => reconnects++);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(HB_INTERVAL_MS);
      hb.alive();
    }
    expect(reconnects).toBe(0);
    hb.stop();
  });

  it("on timeout it tears the socket down and asks the caller to reconnect", () => {
    const sock = mockSock();
    let reconnects = 0;
    const hb = startHeartbeat(sock, () => reconnects++);
    // No alive() — once nothing has arrived for longer than the timeout, the
    // next tick treats the socket as half-open.
    vi.advanceTimersByTime(HB_TIMEOUT_MS + HB_INTERVAL_MS);
    expect(reconnects).toBe(1);
    expect(sock.onclose).toBeNull(); // delayed onclose path is disarmed
    expect(sock.closes).toBe(1);

    // The heartbeat has stopped: no more pings after the stale teardown.
    const before = sock.sent.length;
    vi.advanceTimersByTime(HB_INTERVAL_MS * 3);
    expect(sock.sent.length).toBe(before);
    void hb;
  });

  it("stop() halts all further pings", () => {
    const sock = mockSock();
    const hb = startHeartbeat(sock, () => {});
    hb.stop();
    vi.advanceTimersByTime(HB_INTERVAL_MS * 5);
    expect(sock.sent).toEqual([]);
  });
});
