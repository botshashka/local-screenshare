# local-screenshare

Stream your screen to a TV or another device on the same network — no accounts, no cloud relay, no installs on the receiver. Two senders, one receiver, pure WebRTC over your LAN.

## Requirements

- [Node.js](https://nodejs.org) 18+
- `openssl` on the host machine (used once to generate a self-signed cert)
- A browser that supports `getDisplayMedia` on each device (Chrome, Edge, Safari 13+)

## Setup

```bash
npm install
npm start
```

The server prints three URLs on startup — open each on the relevant device.

## Usage

| Role | URL |
|---|---|
| Device A (sender) | `https://<server-ip>:4242/sender.html?id=device-a` |
| Device B (sender) | `https://<server-ip>:4242/sender.html?id=device-b` |
| Receiver (TV) | `https://<server-ip>:4242/receiver.html` |

On first visit, each device will show a self-signed certificate warning — click **Advanced → Proceed** to continue. This only happens once per device.

On the sender page, click **Share Screen** and pick a window or display. Streaming starts automatically once the receiver is connected.

## Receiver controls

The receiver cycles through five layouts via the button at the bottom, **L / Space** on a keyboard, or the **blue button** on a TV remote:

| Layout | Description |
|---|---|
| Side by Side | Equal split |
| Device A Focus | A full-screen, B in corner |
| Device B Focus | B full-screen, A in corner |
| Device A Only | B hidden |
| Device B Only | A hidden |

Click a picture-in-picture corner to swap focus. The layout is saved across page reloads.

## How it works

The Node.js server handles HTTPS and WebSocket signaling only — no media passes through it. Video and audio stream directly between sender and receiver via WebRTC (VP9, up to 6 Mbps per sender). Everything stays on the local network.

The self-signed TLS certificate is generated once on first run and persisted in `.certs/`.
