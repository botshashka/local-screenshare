import express, { type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import * as http from "http";
import * as https from "https";
import { execSync } from "child_process";
import { networkInterfaces } from "os";
import { readFileSync, mkdirSync, existsSync } from "fs";
import * as path from "path";
import { createHub, HB_INTERVAL_MS } from "./hub";

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

// One signaling hub shared by both listeners (HTTPS senders + HTTP receiver).
const hub = createHub({ log: (m) => console.log(m) });
wssHttps.on("connection", (ws) => hub.handleConnection(ws));
wssHttp.on("connection", (ws) => hub.handleConnection(ws));

// Liveness sweep: reap any socket that's gone silent past the heartbeat timeout,
// freeing its sender slot so a reconnecting device isn't blocked by its ghost.
setInterval(() => hub.sweep(), HB_INTERVAL_MS).unref();

const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 4242;
// HTTP receiver port sits right after the HTTPS port; override with HTTP_PORT.
const HTTP_PORT = process.env["HTTP_PORT"] ? parseInt(process.env["HTTP_PORT"], 10) : PORT + 1;

const lanIp = ips.find((ip) => ip !== "127.0.0.1") ?? "localhost";
httpsServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `\nScreenshare running on https://${lanIp}:${PORT} (senders) + http://${lanIp}:${HTTP_PORT} (TV)`,
  );
  // Senders are auto-assigned Device A then Device B by arrival order — just
  // open the one URL on each device. (?id=device-a/-b still works as a hint.)
  console.log(`\n  Sender(s):  https://${lanIp}:${PORT}/sender.html`);
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
