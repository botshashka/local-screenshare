# Signaling hub — Cloudflare Worker (optional)

This is **one** way to host the screenshare signaling hub: a Cloudflare Worker + Durable Object,
one DO instance per room code, free on Cloudflare's plan (SQLite Durable Objects + WebSocket
hibernation, so idle rooms cost nothing).

It is a drop-in alternative to the local [`../src/server.ts`](../src/server.ts) — both speak the
same WebSocket signaling protocol, and the browser client points at whichever you configure (see
the [repo README](../README.md#hosting-it-zero-install)). **If you don't use Cloudflare, ignore
this folder** and run `server.ts`, or any other WebSocket host that implements the protocol below.

## Use

```bash
pnpm install
pnpm dev        # local hub via Miniflare (ws://localhost:8787)
pnpm deploy     # publish; prints your hub URL
pnpm test       # vitest inside workerd — DO slot assignment, relay, liveness
pnpm typecheck
```

Then set your hub's host in the pages' `<meta name="signaling-hub">` (or pass `?hub=` for a quick
test). Clients connect to `wss://<hub>/ws?room=CODE`; each code maps to its own Durable Object, so
rooms are isolated.

## Protocol

A faithful port of `server.ts`'s relay:

- A client opens `…/ws?room=CODE` and sends `{ type: "register", id }` where `id` is `"receiver"`
  or a sender id (`device-a` / `device-b`).
- On every join the hub re-syncs peers (`sender-connected` to the receiver, `receiver-ready` to
  senders), so the room survives peers coming and going.
- Any message carrying a `to` field is relayed to that peer, with `from` stamped from the
  connection's own registered id (never trusting a client-supplied `from`).
- `peer-disconnected` is emitted to the remaining peers on close.

Media never passes through the hub — it only brokers the WebRTC handshake.
