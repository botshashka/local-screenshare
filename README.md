# local-screenshare

Stream your screen to a TV or another device on the same network — no accounts, no cloud relay, no installs on the receiver. Up to four senders, one receiver, pure WebRTC over your LAN.

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
| Sender(s) | `https://<server-ip>:4242/sender.html` |
| Receiver (TV) | `http://<server-ip>:4243/receiver.html` |

Open the sender URL on each device that should share — devices become **Device A** through **Device D** by arrival order (no slot to pick). A fifth is turned away and waits, claiming the first slot that frees up. Append `?id=device-a` (…`-d`) to hint a preferred slot; it's honored only when that slot is free, so it can never bump someone already sharing.

On first visit, each **sender** will show a self-signed certificate warning — click **Advanced → Proceed** to continue. This only happens once per device.

The **receiver** is served over plain HTTP (port 4243, one above the HTTPS port) with no cert prompt. Senders need HTTPS for `getDisplayMedia`, but the receiver only *receives* video, so it needs no secure context — and this avoids a hang some smart-TV browsers have when opening a `wss://` socket against a self-signed cert. Type the `http://` URL in full on the TV so the browser doesn't auto-upgrade to `https`. Override the port with `HTTP_PORT=` if needed.

On the sender page, click **Share Screen** and pick a window or display. Streaming starts automatically once the receiver is connected.

## Receiver controls

The four colored buttons on a TV remote **are** the four device slots, in join order. That's the whole model — there's no fifth button to learn, because pressing a color you're already on cycles that device's view instead:

| Button | Keyboard | Selects |
|---|---|---|
| 🔴 Red | `R` / `1` | **Device A** |
| 🟢 Green | `G` / `2` | **Device B** |
| 🟡 Yellow | `Y` / `3` | **Device C** |
| 🔵 Blue | `B` / `4` | **Device D** |

Press a color for a device you're not on and it takes over the screen. Press the color you're **already** on and it advances:

> **Only** → **+ corners** (the others as thumbnails) → **All screens** → back to Only

Switching devices keeps the current style, so flipping A↔B stays full-screen if you were full-screen and keeps the corner strip if you had one. Pressing a color nobody has joined does nothing and dims that key in the legend. Each press pops up a color-key legend at the top of the screen; the key you're on states what one more press will do, so the cycle explains itself.

**All screens** fits the connected devices to the panel — one fills it, two split it in half, three or four tile it 2×2 — and hands the join QR any leftover pane, so the next person can scan in without anyone stopping. Every pane that shares the screen is labeled with its device name and its remote color, with the letter inside the dot so the panes are still tellable apart if the colors aren't.

On a desktop you can also cycle every view with the on-screen button at the bottom or **L / Space**, and click any pane (a grid cell or a corner thumbnail) to bring it to the front. The view is saved across page reloads, and comes back when its device does.

## Hosting it (zero-install)

The local `pnpm start` above runs the signaling server on your own machine — great for an offline LAN, but everyone has to be able to reach *your* host. To make this a thing people just open in a browser (nothing to install or launch), serve the **static pages** from any static host and run the **signaling hub** anywhere that can hold a WebSocket. The client isn't tied to a provider — it resolves its hub from `?hub=` → the build-time `SIGNALING_HUB` (baked into `js/config.js`) → `<meta name="signaling-hub">` → its own origin, so you point it wherever you like (and with nothing set it just falls back to a co-located `server.ts`).

Whatever you pick, media still flows **peer-to-peer over the LAN** — the hub only relays the SDP/ICE handshake, never the video. The client adds public **STUN** for candidate gathering and runs **no TURN**, so nothing is ever relayed through the cloud (a relay-hostile network just fails to connect instead of routing video off-LAN). Serve the pages over real TLS and the self-signed-cert warning on senders and the smart-TV `wss://` hang both disappear.

So there are two pieces to place:

1. **Static pages** — `pnpm build` emits everything needed into `public/`; deploy that directory to any static host or CDN.
2. **Signaling hub** — run `src/server.ts` on a small always-on box (it's the portable reference hub, any WebSocket host works), or use the ready-made serverless recipe below.

**Telling the pages where the hub is.** Set the `SIGNALING_HUB` env var at build time — `pnpm build` bakes it into a gitignored `public/js/config.js`, so the host never lands in source:

```bash
SIGNALING_HUB=signaling.example.com pnpm build
```

(No-build alternatives: hand-edit `<meta name="signaling-hub">` in the two HTML files, or append `?hub=…` to a URL for a one-off test. Resolution order is `?hub=` → `SIGNALING_HUB` → `<meta>` → the page's own origin, so with nothing set the pages just talk to wherever they're served from — that's the local `server.ts` path.)

### Recipe: Cloudflare (free, scales to zero)

A self-contained Cloudflare Worker + Durable Object hub lives in [`worker/`](worker/) — one Durable Object per room code, and idle rooms cost nothing (SQLite Durable Objects + WebSocket hibernation on the free plan). It's optional: it's just one way to host the same signaling protocol `server.ts` speaks.

A Cloudflare deploy is **two independent pieces, with two separate deploy commands** — getting clear on which is which avoids all the confusion:

| Piece | What it is | Deploy command | Run it from | Redeploy when you change… |
|---|---|---|---|---|
| **Worker** | the signaling hub (`worker/`) | `pnpm deploy` | `worker/` | anything in `worker/` |
| **Pages** | the static UI (`public/`) | `npx wrangler pages deploy public` | **repo root** | `src/client/`, `public/*.html`, or the hub host |

> There is **no `pnpm deploy` at the repo root** — that script lives only in `worker/package.json` and means "deploy the Worker." The Pages deploy is a separate `wrangler` command run from the repo root.

#### One-time setup

```bash
cd worker
pnpm install
pnpm exec wrangler login          # opens a browser to authorize
```

If the first Worker deploy errors with *"You need a workers.dev subdomain"*, open <https://dash.cloudflare.com> → **Workers & Pages** once (just visiting creates the subdomain), then retry.

#### Step 1 — deploy the Worker (the hub)

```bash
cd worker
pnpm deploy                        # → prints screenshare-signaling.<you>.workers.dev
```

Copy that host; it's your `SIGNALING_HUB` below. **Re-run this only when you change `worker/`.**

#### Step 2 — build + deploy the Pages (the UI)

Run this from the **repo root** (not `worker/` — running it there is what makes wrangler warn about the Worker's `wrangler.toml`):

```bash
cd ..                              # repo root
SIGNALING_HUB=screenshare-signaling.<you>.workers.dev pnpm build
./worker/node_modules/.bin/wrangler pages deploy public --project-name screenshare
```

- `SIGNALING_HUB=… pnpm build` bakes the hub host into the gitignored `public/js/config.js` (kept out of source). Confirm it landed: `cat public/js/config.js` should print your worker host, not be empty.
- `--project-name screenshare` updates the **same** Pages project each time instead of creating new ones. (The name is whatever you pick on first deploy; reuse it.)
- Prefer not to type the binary path? `npx wrangler pages deploy public --project-name screenshare` works too (it just fetches an ephemeral copy).

**Re-run this whenever you change the UI or the hub host** — and don't forget the `SIGNALING_HUB=…` part, or the deployed pages won't know where the hub is.

#### What you end up with

Two entries in your Cloudflare dashboard — **this is correct, not a duplicate**:

- **`screenshare`** (Pages) — the site, e.g. `screenshare-bw8.pages.dev`
- **`screenshare-signaling`** (Worker) — the hub

Open the Pages **receiver** URL on the TV — `https://<your-project>.pages.dev/receiver.html` — real TLS, no cert warning, nothing to install.

#### Updating later (the part people get stuck on)

- Changed **hub** logic (`worker/`)? → `cd worker && pnpm deploy`. Nothing else.
- Changed the **UI** (`src/client/`, `public/`)? → from the repo root, `SIGNALING_HUB=… pnpm build` then `./worker/node_modules/.bin/wrangler pages deploy public --project-name screenshare`.

They're independent; you rarely deploy both at once.

### Joining (rooms)

The **TV** generates a short room code on load and shows it with a **QR code** and a join link. On a phone or laptop, **scan the QR** (or open `…/sender.html?room=CODE`) to land on the sender page already paired to that TV — it's auto-assigned the next free slot, so just hit Share Screen. Prefer typing? The sender page has a join-code box. The code is remembered on the TV across reloads, so senders stay paired. The full join panel hides once a device is streaming, but **All screens** gives the QR + code a pane of its own whenever the grid has a spare one (one device sharing, or three), so the next person can scan in without anyone stopping. It never floats over a picture someone is watching, so with two sharing the grid stays two clean halves.

> **Scope:** screenshare is built for **small home networks**. On the hosted hub the code is namespaced by your network (the Worker keys it by `CF-Connecting-IP`), so it only pairs devices on the same LAN — which is why a 4-character code is enough. It's a convenience gate among your own devices, **not** a security boundary: don't rely on it to keep strangers out on a large shared or carrier-NAT (CGNAT) network, where many unrelated LANs can share one egress IP.

## Quality & performance

Each stream is encoded to match the size it's actually shown at on the receiver: the TV measures every pane (in real device pixels, so a 4K panel asks for 4K-worth and a 1080p panel for 1080p-worth) and the sender encodes exactly that — no pixels wasted, and nothing softer than its pane. A half-width pane is encoded at half-width, a quarter of a 2×2 at a quarter, a focused stream at the full panel resolution (up to its cap). Because the total encoded pixels stay ≈ the panel's pixel count regardless of how many devices are connected, going from two senders to four doesn't blow up encode/decode cost — each one just encodes a smaller frame.

The encode cap is the one hardware-dependent knob (resolution is what drives encode CPU). It's controlled by a **quality preset** on the *sender*:

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

The pure logic in `src/client/rtc-utils.ts` (resolution/bitrate math, preset resolution, the auto-adapt ladder, SDP munging, plus the signaling-URL resolver and room-code helpers) is covered by `test/`.

The optional serverless signaling hub is a separate self-contained project under `worker/` (`pnpm install` there, then `pnpm dev` for a local hub, `pnpm test` for its Durable-Object test suite, or `pnpm deploy` to publish) — see [`worker/README.md`](worker/README.md). It's a faithful port of `server.ts`'s relay; you don't need it if you run `server.ts` (or any other WebSocket hub).

## How it works

The signaling layer handles **signaling only** — no media passes through it. Video and audio stream directly between sender and receiver via WebRTC (H.264, with the per-stream resolution and bitrate driven by the receiver's measured pane sizes and the sender's quality preset — see [Quality & performance](#quality--performance)). Two ways to run that signaling layer:

- **Local (`server.ts`)** — the Node server listens on both HTTPS (senders) and HTTP (the TV receiver) sharing one WebSocket hub, so an `http`-origin receiver and `https`-origin senders pair over the same channel. The self-signed TLS cert is generated once on first run and persisted in `.certs/`. Best for an isolated/offline LAN. It's a single global hub, so the room code is ignored.
- **Hosted hub** — any WebSocket host that routes `wss://…/ws?room=CODE` to a per-room hub instance. A ready-made Cloudflare Worker + Durable Object implementation ships in `worker/src/signaling.ts`; it namespaces each code by the client's network (CF-Connecting-IP), so a code is only shared among devices on the same LAN — that network scoping is what lets the code stay short. Real TLS, zero install. See [Hosting it](#hosting-it-zero-install).

The same client bundles drive both: the page resolves its signaling endpoint from `?hub=` → the build-time `SIGNALING_HUB` (baked into `js/config.js`) → `<meta name="signaling-hub">` → its own origin, so a remotely-served page targets your hub while a `server.ts`-served page stays same-origin. Either way, media stays on the local network — STUN only assists the handshake and no TURN means video is never relayed.
