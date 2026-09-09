import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";

// The receiver's pure parts are pinned down in layout.test.ts (what the view
// model decides) and receiver-controller.test.ts (what each hub message does to
// a slot). This file covers the seam between them and the DOM — that hub
// messages actually reach the stage, and that the stage only asks senders to
// re-encode when something really moved. Everything here needs is a fake socket;
// nothing fakes WebRTC, so `live` transitions stay the reducers' business.

interface Sent {
  type: string;
  to?: string;
  target?: { w: number; h: number };
}

const sockets: FakeWS[] = [];

class FakeWS {
  static OPEN = 1;
  readyState = FakeWS.OPEN;
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Sent);
  }
  close(): void {}
}

function sock(): FakeWS {
  return sockets[sockets.length - 1]!;
}

// Deliver a hub message, then let the post-layout res-hint debounce fire, so
// each assertion sees the settled state rather than a half-applied one.
function deliver(msg: Record<string, unknown>): void {
  sock().onmessage?.({ data: JSON.stringify(msg) });
  vi.advanceTimersByTime(SETTLE_MS);
}

// `.tile` animates for 250ms; the adapter waits it out before measuring.
const SETTLE_MS = 400;
// ws.onclose reconnects on a timer rather than inline.
const RECONNECT_MS = 3000;

function reconnect(): FakeWS {
  const before = sock();
  before.onclose?.();
  vi.advanceTimersByTime(RECONNECT_MS);
  const after = sock();
  expect(after).not.toBe(before);
  after.onopen?.();
  return after;
}

function resHints(): Sent[] {
  return sock().sent.filter((m) => m.type === "res-hint");
}

function slot(id: string): HTMLElement {
  return document.getElementById(`slot-${id}`) as HTMLElement;
}

function visible(): string[] {
  return [...document.querySelectorAll<HTMLElement>("#stage .slot")]
    .filter((el) => !el.hidden)
    .map((el) => el.id);
}

describe("receiver stage", () => {
  beforeAll(async () => {
    vi.useFakeTimers();
    const html = readFileSync("public/receiver.html", "utf8");
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, "");
    (globalThis as unknown as { qrcode: unknown }).qrcode = () => ({
      addData() {},
      make() {},
      createDataURL: () => "data:image/gif;base64,AA",
    });
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = class {
      close(): void {}
    };
    await import("../src/client/receiver");
    sock().onopen?.();
    vi.advanceTimersByTime(SETTLE_MS);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("builds one pane per slot from the shared list, all hidden until someone joins", () => {
    expect([...document.querySelectorAll("#stage .slot")].map((s) => s.id)).toEqual([
      "slot-device-a",
      "slot-device-b",
      "slot-device-c",
      "slot-device-d",
    ]);
    expect(visible()).toEqual([]);
    expect((document.getElementById("joinTile") as HTMLElement).hidden).toBe(true);
    expect(document.getElementById("layoutLabel")?.textContent).toBe("All screens");
  });

  it("carries each slot's letter into its name tag and its legend pill", () => {
    // The letter is the identity that survives without color, so it has to reach
    // both places it is shown.
    expect(slot("device-c").querySelector(".tag")?.textContent).toBe("CDevice C");
    const pills = document.querySelectorAll("#legend .pill");
    expect([...pills].map((p) => p.querySelector(".dot")?.textContent)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("registers and immediately pings, so the snapshot has an end it can observe", () => {
    expect(sock().sent.map((m) => m.type)).toEqual(["register", "ping"]);
  });

  it("shows a pane the moment the hub says its sender joined", () => {
    deliver({ type: "sender-connected", id: "device-b" });
    expect(visible()).toEqual(["slot-device-b"]);
    // One device with no hub to invite into: the whole stage, drawn as the
    // full-bleed picture it is rather than as a grid cell.
    expect(slot("device-b").classList.contains("kind-main")).toBe(true);
    expect(slot("device-b").style.width).toBe("100%");
  });

  it("tells only the joined sender what to encode, and only once", () => {
    expect(resHints().map((m) => m.to)).toEqual(["device-b"]);
    // A second device joining does not re-state B's unchanged target: every hint
    // costs the sender a setParameters round on a live encoder.
    deliver({ type: "sender-connected", id: "device-d" });
    expect(visible()).toEqual(["slot-device-b", "slot-device-d"]);
    expect(resHints().filter((m) => m.to === "device-b").length).toBe(1);
    expect(resHints().filter((m) => m.to === "device-d").length).toBe(1);
    // And nothing is ever aimed at a slot nobody has joined.
    expect(resHints().some((m) => m.to === "device-a" || m.to === "device-c")).toBe(false);
  });

  it("drops a pane when the hub says that sender left", () => {
    deliver({ type: "peer-disconnected", id: "device-d" });
    expect(visible()).toEqual(["slot-device-b"]);
  });

  it("prunes what the register snapshot omits, but only once the pong closes it", () => {
    // Reconnect: B is still ours, and while we were away it left. The hub's reply
    // mentions only D, so B is stale — but nothing may be torn down until the
    // pong proves the snapshot actually arrived.
    reconnect();
    deliver({ type: "sender-connected", id: "device-d" });
    expect(visible()).toEqual(["slot-device-b", "slot-device-d"]);
    deliver({ type: "pong" });
    expect(visible()).toEqual(["slot-device-d"]);
  });

  it("prunes nothing when no pong arrives, so a dead socket can't blank the stage", () => {
    // The snapshot never lands and the socket dies again. Firing a prune on that
    // silence would close every live peer connection and cover the screen with
    // the join card, so D has to still be here.
    reconnect();
    sock().onclose?.();
    vi.advanceTimersByTime(RECONNECT_MS);
    expect(visible()).toEqual(["slot-device-d"]);
  });

  it("re-states every target on a fresh socket, since senders may be fresh too", () => {
    // The cache can't know what a reconnected sender still holds, so a repeat of
    // an identical target is exactly what's wanted here.
    const fresh = reconnect();
    deliver({ type: "sender-connected", id: "device-d" });
    expect(fresh.sent.filter((m) => m.type === "res-hint" && m.to === "device-d").length).toBe(1);
  });
});
