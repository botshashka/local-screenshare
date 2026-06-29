// Pure sender media-lifecycle controller. It sits ABOVE the negotiation reducer
// (sender-session.ts): this owns the *policy* — when to acquire a capture,
// hot-swap the live tracks, renegotiate a fresh peer connection, or tear down —
// while senderReduce stays the *mechanism* (offer/answer/ICE). The adapter in
// sender.ts performs all real getDisplayMedia / RTCPeerConnection / DOM I/O and
// translates this controller's `renegotiate` / `teardown-peer` actions into
// senderReduce events (`offer-trigger` / `peer-gone`).
//
// Every getDisplayMedia capture is tagged with a monotonic generation (`gen`).
// The gen is the airtight replacement for the old `if (stream !== next) return`
// onended closure guard: a superseded acquisition, or a stale capture's `ended`
// event, is dropped by gen rather than by object identity threaded through a
// closure. This is the same idea as the negotiation Epoch, applied to the source.
//
// Why the non-obvious rules exist (each prevents a real regression):
//   • `socket-down` (signaling WS closed) is NOT `receiver-gone`. A signaling blip
//     must keep the live PC + capture — media is P2P and keeps flowing to the TV.
//     Only the hub's explicit peer-disconnected (`receiver-gone`) tears down.
//   • `conn` is owned here and reset to "connecting" on every renegotiate and
//     "idle" on teardown. A re-share landing during a rebuild must NOT see a stale
//     "connected" and hot-swap onto a peer connection that isn't established.
//   • the hot-swap path emits `swap-tracks{gen, retireGen}` so the adapter can
//     sequence replaceTrack → stop(retireGen): the outbound stream never goes dark.
//   • `use-capture` is the sole writer of "the stream the next PC is built from",
//     and always precedes a (terminal) `renegotiate`, so every PC is provably
//     built from the current capture — which is also what keeps the cached
//     `hasAudio` hot-swap predicate honest across an audio→none→audio sequence.

export type Gen = number;

export type ConnPhase = "idle" | "connecting" | "connected";

export interface Capture {
  gen: Gen;
  hasAudio: boolean;
}

export interface SenderControllerState {
  // The live, attached capture, or null when we hold nothing to share.
  capture: Capture | null;
  // A getDisplayMedia request that's been issued but hasn't resolved yet. Its
  // result is only honored if it's still the current request (gen === pendingGen).
  pendingGen: Gen | null;
  nextGen: Gen;
  // The hub has told us a receiver is up. Cleared by a signaling drop; only a real
  // `receiver-ready` message sets it back (a WS reconnect alone does not).
  receiverReady: boolean;
  // Mirror of the live PC's lifecycle, owned here (not read live) so the hot-swap
  // decision is pure. Reset deterministically on renegotiate/teardown.
  conn: ConnPhase;
  retryPending: boolean;
}

export const initialControllerState: SenderControllerState = {
  capture: null,
  pendingGen: null,
  nextGen: 1,
  receiverReady: false,
  conn: "idle",
  retryPending: false,
};

export type SenderControllerEvent =
  // The user clicked Share / Re-share.
  | { t: "share-requested" }
  // Adapter: getDisplayMedia resolved for `gen`.
  | { t: "capture-acquired"; gen: Gen; hasAudio: boolean }
  // Adapter: getDisplayMedia rejected/cancelled for `gen`.
  | { t: "capture-failed"; gen: Gen }
  // Adapter: a capture's track ended (browser "Stop sharing", or our own stop).
  | { t: "capture-ended"; gen: Gen }
  // Wire: the hub says a receiver is up.
  | { t: "receiver-ready" }
  // Wire: the hub says the receiver genuinely left (peer-disconnected).
  | { t: "receiver-gone" }
  // Adapter: the signaling socket closed (ws.onclose) — keep the P2P session.
  | { t: "socket-down" }
  // Wire: the receiver asked everyone to re-offer (request-reoffers).
  | { t: "reoffer-requested" }
  // Adapter: pc.connectionState advanced.
  | { t: "connection-changed"; phase: "connecting" | "connected" }
  // Adapter: pc.connectionState === "failed".
  | { t: "connection-failed" }
  // Adapter: the failed-connection retry timer elapsed.
  | { t: "retry-fired" };

export type SenderControllerAction =
  // Adapter: getDisplayMedia, tagging the result with `gen`.
  | { t: "acquire-capture"; gen: Gen }
  // Adapter: point "the stream the next PC is built from" at captures[gen].
  | { t: "use-capture"; gen: Gen }
  // Adapter: preview.srcObject = captures[gen] + bind a gen-tagged onended.
  | { t: "attach-preview"; gen: Gen }
  // Adapter: hide the preview and reset the Share button to its idle label — the
  // last capture is gone, so the sender returns to its "nothing shared" state.
  | { t: "detach-preview" }
  // Adapter: replaceTrack the live senders from captures[gen], THEN stop+drop
  // captures[retireGen] (in that order, so the stream never goes dark).
  | { t: "swap-tracks"; gen: Gen; retireGen: Gen }
  // Adapter: clear onended, stop tracks, drop captures[gen].
  | { t: "stop-capture"; gen: Gen }
  // Adapter: dispatch a fresh offer-trigger into senderReduce. Always terminal in
  // an action array, and always preceded by a use-capture.
  | { t: "renegotiate" }
  // Adapter: dispatch peer-gone into senderReduce.
  | { t: "teardown-peer" }
  // Adapter: tell the receiver we deliberately stopped, so it blanks at once.
  | { t: "announce-stopped" }
  | { t: "schedule-retry" }
  | { t: "cancel-retry" };

interface Result {
  state: SenderControllerState;
  actions: SenderControllerAction[];
}

// The tail shared by every "(re)offer" path: cancel a pending retry (so a stale
// timer can't fire after we've reconnected) then the terminal renegotiate.
function reofferTail(retryPending: boolean): SenderControllerAction[] {
  return retryPending ? [{ t: "cancel-retry" }, { t: "renegotiate" }] : [{ t: "renegotiate" }];
}

export function senderControllerReduce(
  state: SenderControllerState,
  event: SenderControllerEvent,
): Result {
  switch (event.t) {
    case "share-requested": {
      const gen = state.nextGen;
      return {
        state: { ...state, pendingGen: gen, nextGen: gen + 1 },
        actions: [{ t: "acquire-capture", gen }],
      };
    }

    case "capture-acquired": {
      // Superseded by a newer request (double-click / rapid re-share): the orphan
      // stream is real and must be stopped, but it never becomes the live capture.
      if (event.gen !== state.pendingGen) {
        return { state, actions: [{ t: "stop-capture", gen: event.gen }] };
      }
      const old = state.capture;
      const capture: Capture = { gen: event.gen, hasAudio: event.hasAudio };
      const base: SenderControllerState = { ...state, capture, pendingGen: null };

      // Hot-swap: an established connection whose audio-sender presence is
      // unchanged can take the new tracks in place — no renegotiation, so the
      // receiver keeps the same track/element and there's no teardown flash.
      if (state.conn === "connected" && old !== null && old.hasAudio === capture.hasAudio) {
        return {
          state: base,
          actions: [
            { t: "use-capture", gen: capture.gen },
            { t: "attach-preview", gen: capture.gen },
            { t: "swap-tracks", gen: capture.gen, retireGen: old.gen },
          ],
        };
      }

      // Otherwise bring it online by (re)negotiating a fresh PC — but only if a
      // receiver is actually up. With none yet we hold the capture and wait
      // (the view shows "waiting"); a later receiver-ready will renegotiate.
      const actions: SenderControllerAction[] = [
        { t: "use-capture", gen: capture.gen },
        { t: "attach-preview", gen: capture.gen },
      ];
      // Retire the previous capture's tracks. The fresh PC is built from the new
      // capture, so there's no shared track — stopping the old one now is safe.
      if (old !== null) actions.push({ t: "stop-capture", gen: old.gen });
      if (state.receiverReady) {
        return {
          state: { ...base, conn: "connecting", retryPending: false },
          actions: [...actions, ...reofferTail(state.retryPending)],
        };
      }
      return { state: base, actions };
    }

    case "capture-failed": {
      // A stale failure (from a superseded request) must not clear a newer pending
      // one, and must never touch the live capture — so cancelling a re-share's
      // picker leaves the existing share running.
      if (event.gen !== state.pendingGen) return { state, actions: [] };
      return { state: { ...state, pendingGen: null }, actions: [] };
    }

    case "capture-ended": {
      // THE bug guard: a superseded capture's `ended` (it was replaced by a
      // re-share) is ignored; only the live capture ending tears down.
      if (!state.capture || event.gen !== state.capture.gen) return { state, actions: [] };
      // Retire the ended capture (drop it from the adapter's map + stop any
      // sibling tracks), return the preview/button to idle, and tear the peer down.
      const actions: SenderControllerAction[] = [
        { t: "announce-stopped" },
        { t: "stop-capture", gen: event.gen },
        { t: "detach-preview" },
        { t: "teardown-peer" },
      ];
      if (state.retryPending) actions.push({ t: "cancel-retry" });
      return {
        state: { ...state, capture: null, conn: "idle", retryPending: false },
        actions,
      };
    }

    case "receiver-ready": {
      const next = { ...state, receiverReady: true };
      if (!state.capture) return { state: next, actions: [] };
      return {
        state: { ...next, conn: "connecting", retryPending: false },
        actions: [{ t: "use-capture", gen: state.capture.gen }, ...reofferTail(state.retryPending)],
      };
    }

    case "reoffer-requested": {
      if (!state.capture) return { state, actions: [] };
      return {
        state: { ...state, conn: "connecting", retryPending: false },
        actions: [{ t: "use-capture", gen: state.capture.gen }, ...reofferTail(state.retryPending)],
      };
    }

    case "receiver-gone": {
      const actions: SenderControllerAction[] = [{ t: "teardown-peer" }];
      if (state.retryPending) actions.push({ t: "cancel-retry" });
      return {
        state: { ...state, receiverReady: false, conn: "idle", retryPending: false },
        actions,
      };
    }

    case "socket-down": {
      // Signaling only. Keep capture, conn, and the peer — media is P2P. A real
      // receiver-ready (not a mere reconnect) is what flips receiverReady back.
      return { state: { ...state, receiverReady: false }, actions: [] };
    }

    case "connection-changed": {
      if (event.phase === "connected") {
        const actions: SenderControllerAction[] = state.retryPending ? [{ t: "cancel-retry" }] : [];
        return { state: { ...state, conn: "connected", retryPending: false }, actions };
      }
      return { state: { ...state, conn: "connecting" }, actions: [] };
    }

    case "connection-failed": {
      // Schedule exactly one retry; treat the window until it fires as "connecting"
      // so a re-share in the meantime renegotiates rather than hot-swapping onto
      // the dead PC.
      if (state.retryPending) return { state, actions: [] };
      return {
        state: { ...state, conn: "connecting", retryPending: true },
        actions: [{ t: "schedule-retry" }],
      };
    }

    case "retry-fired": {
      const next = { ...state, retryPending: false };
      if (state.capture && state.receiverReady) {
        return {
          state: { ...next, conn: "connecting" },
          actions: [{ t: "use-capture", gen: state.capture.gen }, { t: "renegotiate" }],
        };
      }
      return { state: next, actions: [] };
    }
  }
}

// ── Derived presentation ────────────────────────────────────────────────────
// Status text + favicon as a total pure function of controller state, so the
// adapter never has to remember to call setStatus on a transition. The adapter
// overlays its own signaling-level statuses (joining / room-full / server-down),
// which depend on registration state it owns, with precedence over this.

export type FaviconColor = "green" | "amber" | "grey";
export type StatusClass = "" | "connected" | "error";

export interface SenderView {
  status: string;
  cls: StatusClass;
  favicon: FaviconColor;
}

export function senderView(s: SenderControllerState): SenderView {
  const favicon: FaviconColor =
    s.conn === "connected" && s.capture ? "green" : s.receiverReady ? "amber" : "grey";

  if (s.retryPending) {
    return { status: "Connection failed — retrying…", cls: "error", favicon };
  }
  if (s.capture) {
    if (s.conn === "connected") return { status: "Streaming to TV", cls: "connected", favicon };
    if (s.receiverReady) return { status: "Connecting to TV…", cls: "connected", favicon };
    return { status: "Waiting for TV receiver…", cls: "", favicon };
  }
  if (s.receiverReady) {
    return { status: "TV receiver connected — press Share to start", cls: "connected", favicon };
  }
  // No capture, no receiver: the adapter's signaling status (joining / waiting for
  // server / room-full) takes over, so leave this blank.
  return { status: "", cls: "", favicon };
}
