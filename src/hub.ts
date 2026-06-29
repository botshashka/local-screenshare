import type { WebSocket } from "ws";
import {
  onMessage,
  onClose,
  sweep as coreSweep,
  HB_INTERVAL_MS,
  HB_TIMEOUT_MS,
  SENDER_IDS,
  WS_OPEN,
  type Attach,
  type Op,
  type SignalMsg,
  type Snapshot,
} from "./core/room";

// The Node `ws` adapter over the shared hub core (src/core/room.ts). All slot,
// claim, relay, and liveness DECISIONS live in the core; this file only owns the
// runtime glue — `ws` event wiring and the per-socket attachment store — and
// translates the core's ops onto real sockets. The Cloudflare Worker
// (worker/src/signaling.ts) is the same core behind a different adapter, so the
// two can no longer drift.

export { HB_INTERVAL_MS, HB_TIMEOUT_MS, SENDER_IDS };

export interface Hub {
  // The single live socket per registered id, derived on access. For tests.
  readonly clients: Map<string, WebSocket>;
  // Wire up one accepted connection (message/close/error + attachment).
  handleConnection(ws: WebSocket): void;
  // Reap every socket silent past the timeout. Driven on an interval by the server
  // (the core also reaps opportunistically at the top of each message). `now` is
  // injectable for tests.
  sweep(now?: number): void;
}

export function createHub(opts: { log?: (msg: string) => void; timeoutMs?: number } = {}): Hub {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? HB_TIMEOUT_MS;
  // The adapter's sole state: every open socket and its current attachment. The
  // core reads a snapshot of this and returns ops we apply back onto it.
  const conns = new Map<WebSocket, Attach>();

  function snapshot(): Snapshot<WebSocket> {
    const list: { key: WebSocket; attach: Attach }[] = [];
    for (const [key, attach] of conns) list.push({ key, attach });
    return { conns: list };
  }

  function applyOps(ops: Op<WebSocket>[]): void {
    for (const op of ops) {
      if (op.op === "send") {
        if (op.to.readyState === WS_OPEN) op.to.send(JSON.stringify(op.msg));
      } else if (op.op === "attach") {
        const prev = conns.get(op.key)?.id ?? null;
        conns.set(op.key, op.attach);
        if (op.attach.id && op.attach.id !== prev) log(`[+] ${op.attach.id}`);
        else if (op.attach.id === null && prev) log(`[-] ${prev}`);
      } else {
        // Reap a silent ghost hard — terminate() yields 1006, the right signal for a
        // half-open socket that may never complete a graceful close. A replaced
        // socket closes gracefully (1000). The socket's own 'close' handler removes
        // it from `conns`; the attachment was nulled by the preceding op so that
        // close can't double-announce.
        try {
          if (op.kind === "reap") (op.key as { terminate?: () => void }).terminate?.();
          else op.key.close(1000, "replaced");
        } catch {
          // already gone
        }
      }
    }
  }

  function handleConnection(ws: WebSocket): void {
    conns.set(ws, { id: null, seen: Date.now(), token: "" });

    ws.on("message", (raw: { toString(): string }) => {
      let msg: SignalMsg;
      try {
        msg = JSON.parse(raw.toString()) as SignalMsg;
      } catch {
        return;
      }
      applyOps(onMessage(snapshot(), ws, msg, Date.now(), timeoutMs).ops);
    });

    // Swallow per-socket errors so an abrupt drop can't surface as an unhandled
    // 'error' event; the 'close' that follows handles cleanup.
    ws.on("error", () => {});

    ws.on("close", () => {
      const id = conns.get(ws)?.id ?? null;
      applyOps(onClose(snapshot(), ws).ops);
      if (id) log(`[-] ${id}`);
      conns.delete(ws);
    });
  }

  function sweep(now = Date.now()): void {
    applyOps(coreSweep(snapshot(), now, timeoutMs).ops);
  }

  return {
    get clients(): Map<string, WebSocket> {
      const m = new Map<string, WebSocket>();
      for (const [ws, attach] of conns) if (attach.id) m.set(attach.id, ws);
      return m;
    },
    handleConnection,
    sweep,
  };
}
