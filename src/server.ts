import express, { type Request, type Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import * as http from "http";
import * as https from "https";
import { execSync } from "child_process";
import { networkInterfaces } from "os";
import { readFileSync, mkdirSync, existsSync } from "fs";
import * as path from "path";

const SENDER_IDS = ["device-a", "device-b"] as const;

interface WsMsg {
  type: string;
  id?: string;
  to?: string;
  from?: string;
  sdp?: string;
  candidate?: unknown;
  target?: { w: number; h: number };
}

const ips: string[] = ["127.0.0.1"];
for (const nets of Object.values(networkInterfaces())) {
  if (!nets) continue;
  for (const net of nets) {
    if (net.family === "IPv4" && !net.internal) ips.push(net.address);
  }
}
const san = ips.map((ip) => `IP:${ip}`).join(",") + ",DNS:localhost";

const certDir = path.join(__dirname, "..", ".certs");
mkdirSync(certDir, { recursive: true });
const keyFile = `${certDir}/key.pem`;
const certFile = `${certDir}/cert.pem`;
if (!existsSync(keyFile) || !existsSync(certFile)) {
  console.log("Generating self-signed cert (one-time)…");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${keyFile} -out ${certFile}` +
      ` -sha256 -days 3650 -nodes -subj "/CN=screenshare"` +
      ` -addext "subjectAltName=${san}" 2>/dev/null`,
  );
}

const app = express();
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    // LAN dev tool: never let a receiver (TVs cache aggressively) serve a stale
    // client after a rebuild. cacheControl:false stops express from forcing its
    // own max-age=0 over ours; no-store on HTML/JS then forces a fresh fetch
    // each load, so HTML and its bundle can't drift out of sync.
    cacheControl: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html") || filePath.endsWith(".js")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);
app.get("/", (_req: Request, res: Response) => res.redirect("/receiver.html"));

// Two listeners share one signaling hub:
//   • HTTPS — senders need a secure context for getDisplayMedia().
//   • HTTP  — the TV receiver only *receives* WebRTC (no capture), so it needs
//     no secure context. Some smart-TV browsers hang forever on a wss://
//     handshake against a self-signed cert; plain ws:// has
//     no TLS step to stall on. WebRTC media is P2P and origin-independent, so an
//     http-origin receiver still pairs with the https-origin senders.
const httpsServer = https.createServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  app,
);
const httpServer = http.createServer(app);
const wssHttps = new WebSocketServer({ server: httpsServer });
const wssHttp = new WebSocketServer({ server: httpServer });

const clients = new Map<string, WebSocket>();

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleConnection(ws: WebSocket): void {
  let clientId: string | null = null;

  ws.on("message", (raw) => {
    let msg: WsMsg;
    try {
      msg = JSON.parse(raw.toString()) as WsMsg;
    } catch {
      return;
    }

    if (msg.type === "register" && msg.id) {
      clientId = msg.id;
      clients.set(clientId, ws);
      console.log(`[+] ${clientId}`);

      if (clientId === "receiver") {
        // Set up the receiver (sender-connected) before telling senders to
        // (re)offer (receiver-ready), mirroring the sender branch below, so the
        // receiver's peer connection exists before an offer can arrive.
        for (const id of SENDER_IDS) {
          if (clients.has(id)) send(ws, { type: "sender-connected", id });
        }
        for (const id of SENDER_IDS) {
          const sender = clients.get(id);
          if (sender) send(sender, { type: "receiver-ready" });
        }
      } else {
        const receiver = clients.get("receiver");
        if (receiver) {
          send(receiver, { type: "sender-connected", id: clientId });
          send(ws, { type: "receiver-ready" });
        }
      }
      return;
    }

    if (msg.to) {
      const target = clients.get(msg.to);
      if (target) send(target, msg);
    }
  });

  // Swallow per-socket errors so an abrupt drop can't surface as an unhandled
  // 'error' event; the 'close' that follows handles cleanup.
  ws.on("error", () => {});

  ws.on("close", () => {
    if (!clientId) return;
    clients.delete(clientId);
    console.log(`[-] ${clientId}`);

    if (clientId === "receiver") {
      for (const id of SENDER_IDS) {
        const sender = clients.get(id);
        if (sender) send(sender, { type: "peer-disconnected", id: "receiver" });
      }
    } else {
      const receiver = clients.get("receiver");
      if (receiver) send(receiver, { type: "peer-disconnected", id: clientId });
    }
  });
}
wssHttps.on("connection", handleConnection);
wssHttp.on("connection", handleConnection);

const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 4242;
// HTTP receiver port sits right after the HTTPS port; override with HTTP_PORT.
const HTTP_PORT = process.env["HTTP_PORT"] ? parseInt(process.env["HTTP_PORT"], 10) : PORT + 1;

const lanIp = ips.find((ip) => ip !== "127.0.0.1") ?? "localhost";
httpsServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `\nScreenshare running on https://${lanIp}:${PORT} (senders) + http://${lanIp}:${HTTP_PORT} (TV)`,
  );
  console.log(`\n  Device A:   https://${lanIp}:${PORT}/sender.html?id=device-a`);
  console.log(`  Device B:   https://${lanIp}:${PORT}/sender.html?id=device-b`);
  console.log(`  TV:         http://${lanIp}:${HTTP_PORT}/receiver.html`);
  console.log(
    `\n  ⚠  Senders: click "Advanced" → "Proceed" to bypass the self-signed cert warning.` +
      `\n     TV: open the plain http:// URL above — no cert prompt, and it avoids the wss:// hang` +
      `\n     some smart-TV browsers have with self-signed certs.\n`,
  );
});
httpServer.listen(HTTP_PORT, "0.0.0.0");

function onServerError(err: NodeJS.ErrnoException): void {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT}/${HTTP_PORT} is already in use. Set PORT= / HTTP_PORT= to use others.\n`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
}
// ws re-emits the http server's 'error' on the WebSocketServer instance, so a
// listen failure (e.g. EADDRINUSE) surfaces there — handle all to be safe.
httpsServer.on("error", onServerError);
httpServer.on("error", onServerError);
wssHttps.on("error", onServerError);
wssHttp.on("error", onServerError);
