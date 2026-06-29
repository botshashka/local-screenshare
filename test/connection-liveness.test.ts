import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  trackConnectionLiveness,
  isDeadConnectionState,
  DISCONNECT_GRACE_MS,
} from "../src/client/rtc-utils";

// trackConnectionLiveness separates a transient ICE flap (a `disconnected` that
// self-heals) from a real loss (`failed`, or a `disconnected` held past the grace
// window). Fake timers let us drive the grace window deterministically.
describe("trackConnectionLiveness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not report a loss for a disconnect that recovers within the grace window", () => {
    let lost = 0;
    const w = trackConnectionLiveness({ onLost: () => lost++ });
    w.update("disconnected");
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
    w.update("connected");
    // Even well past the original grace deadline, the cancelled timer can't fire.
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2);
    expect(lost).toBe(0);
    w.stop();
  });

  it("reports a loss for a disconnect held past the grace window", () => {
    let lost = 0;
    const w = trackConnectionLiveness({ onLost: () => lost++ });
    w.update("disconnected");
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(lost).toBe(1);
    w.stop();
  });

  it("reports a loss immediately on failed, without waiting", () => {
    let lost = 0;
    const w = trackConnectionLiveness({ onLost: () => lost++ });
    w.update("failed");
    expect(lost).toBe(1); // no timer advance needed
    w.stop();
  });

  it("fires onLost at most once across repeated bad states", () => {
    let lost = 0;
    const w = trackConnectionLiveness({ onLost: () => lost++ });
    w.update("disconnected");
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    w.update("disconnected"); // a second flap must not re-arm a fresh escalation
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    w.update("failed");
    expect(lost).toBe(1);
    w.stop();
  });

  it("stop() cancels a pending grace timer", () => {
    let lost = 0;
    const w = trackConnectionLiveness({ onLost: () => lost++ });
    w.update("disconnected");
    w.stop();
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2);
    expect(lost).toBe(0);
  });

  it("honors a custom graceMs", () => {
    let lost = 0;
    const w = trackConnectionLiveness({ graceMs: 1000, onLost: () => lost++ });
    w.update("disconnected");
    vi.advanceTimersByTime(999);
    expect(lost).toBe(0);
    vi.advanceTimersByTime(1);
    expect(lost).toBe(1);
    w.stop();
  });
});

// Guards which connection states force a fresh PC on an incoming (re)offer vs.
// reuse the existing one. The whole RTCPeerConnectionState union is enumerated so
// adding/removing a "dead" state is a deliberate, visible change here.
describe("isDeadConnectionState", () => {
  it("treats failed / closed / disconnected as dead (rebuild)", () => {
    expect(isDeadConnectionState("failed")).toBe(true);
    expect(isDeadConnectionState("closed")).toBe(true);
    expect(isDeadConnectionState("disconnected")).toBe(true);
  });

  it("treats new / connecting / connected as reusable", () => {
    expect(isDeadConnectionState("new")).toBe(false);
    expect(isDeadConnectionState("connecting")).toBe(false);
    expect(isDeadConnectionState("connected")).toBe(false);
  });
});
