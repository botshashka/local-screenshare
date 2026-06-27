# local-screenshare

Stream your screen to a TV or another device on the same network — no accounts, no cloud relay, no installs on the receiver. Two senders, one receiver, pure WebRTC over your LAN.

## Requirements

- [Node.js](https://nodejs.org) 18+
- [pnpm](https://pnpm.io) (`corepack enable` will provide it)
- `openssl` on the host machine (used once to generate a self-signed cert)
- A browser that supports `getDisplayMedia` on each device (Chrome, Edge, Safari 13+)

## Setup

```bash
pnpm install
pnpm start
```

`pnpm start` compiles the TypeScript (server + browser bundles) and then launches the server, which prints the sender and receiver URLs on startup — open each on the relevant device.

## Usage

| Role | URL |
|---|---|
| Device A (sender) | `https://<server-ip>:4242/sender.html?id=device-a` |
| Device B (sender) | `https://<server-ip>:4242/sender.html?id=device-b` |
| Receiver (TV) | `http://<server-ip>:4243/receiver.html` |

On first visit, each **sender** will show a self-signed certificate warning — click **Advanced → Proceed** to continue. This only happens once per device.

The **receiver** is served over plain HTTP (port 4243, one above the HTTPS port) with no cert prompt. Senders need HTTPS for `getDisplayMedia`, but the receiver only *receives* video, so it needs no secure context — and this avoids a hang some smart-TV browsers have when opening a `wss://` socket against a self-signed cert. Type the `http://` URL in full on the TV so the browser doesn't auto-upgrade to `https`. Override the port with `HTTP_PORT=` if needed.

On the sender page, click **Share Screen** and pick a window or display. Streaming starts automatically once the receiver is connected.

## Receiver controls

On a TV remote, the four colored buttons select views directly — three colors are destinations and **blue** toggles the corner picture. Each press pops up a color-key legend at the top of the screen, so the buttons are self-explanatory.

| Button | Keyboard | Action |
|---|---|---|
| 🔴 Red | `R` | Focus **Device A** |
| 🟢 Green | `G` | Focus **Device B** |
| 🟡 Yellow | `Y` | **Side by Side** |
| 🔵 Blue | `B` | Show / hide the other device in the corner |

Focusing a device keeps the other one in the corner; press blue to hide it (full-screen single). That show/hide-corner choice is remembered — it carries over when you switch between A and B, and even after passing back through Side by Side. This reaches all five layouts: Side by Side, Device A/B Focus (other in corner), and Device A/B Only. In Side by Side, a colored dot and device name label each pane.

On a desktop you can also cycle the layouts with the on-screen button at the bottom or **L / Space**, and click a picture-in-picture corner to focus that device. The layout is saved across page reloads.

## Quality & performance

Each stream is encoded to match the size it's actually shown at on the receiver: the TV measures every pane (in real device pixels, so a 4K panel asks for 4K-worth and a 1080p panel for 1080p-worth) and the sender encodes exactly that — no pixels wasted, and nothing softer than its pane. A side-by-side pane is encoded at half-width, a focused stream at the full panel resolution (up to its cap). Because the total encoded pixels stay ≈ the panel's pixel count regardless of how many devices are connected, adding senders doesn't blow up encode/decode cost.

The encode cap is the one hardware-dependent knob (VP9 is software-encoded on most machines, so resolution drives CPU). It's controlled by a **quality preset** on the *sender*:

| Preset | Resolution cap | Set via |
|---|---|---|
| `performance` | 1080p | `?preset=performance` |
| `balanced` | 1440p | `?preset=balanced` |
| `maximum` | 2160p (4K) | `?preset=maximum` |

Append the param to a sender URL (e.g. `…/sender.html?id=device-a&preset=balanced`), or use the **Quality** control on the sender page — both write the same persisted setting. With no choice made, the preset is auto-picked from the machine's CPU core count, so weaker devices don't default to 4K. On top of the preset, the sender watches its encoder's CPU-limitation stats at runtime and **steps the resolution down** automatically if it's struggling (recovering when it eases) — so the preset is a ceiling, not a fixed target, and a busy moment degrades gracefully instead of adding lag.

Press **S** on a sender to toggle a live stats overlay (capture size, actual encoded resolution, framerate, bitrate, and the encoder's quality-limitation reason) — handy for confirming what's really going over the wire.

## Development

The source is TypeScript under `src/` — `src/server.ts` (Node) and `src/client/` (browser). The build compiles the server to `dist/` and the browser bundles to `public/js/` (both git-ignored).

```bash
pnpm build    # compile server + browser bundles
pnpm dev      # rebuild + watch sources and restart the server on change
pnpm lint     # oxlint
pnpm format   # oxfmt
pnpm test     # vitest — unit tests for the encoding/preset/SDP logic
```

The pure encoding logic (resolution/bitrate math, preset resolution, the auto-adapt ladder, SDP munging) lives in `src/client/rtc-utils.ts` and is covered by `test/`.

## How it works

The Node.js server handles signaling only — no media passes through it. It listens on both HTTPS (senders) and HTTP (the TV receiver) sharing one WebSocket hub, so an `http`-origin receiver and `https`-origin senders pair up over the same signaling channel. Video and audio then stream directly between sender and receiver via WebRTC (VP9, with the per-stream resolution and bitrate driven by the receiver's measured pane sizes and the sender's quality preset — see [Quality & performance](#quality--performance)). Everything stays on the local network.

The self-signed TLS certificate is generated once on first run and persisted in `.certs/`.
