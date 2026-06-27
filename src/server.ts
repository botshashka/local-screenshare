import express, { type Request, type Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
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
  hint?: string;
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
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/", (_req: Request, res: Response) => res.redirect("/receiver.html"));

const server = https.createServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  app,
);
const wss = new WebSocketServer({ server });

const clients = new Map<string, WebSocket>();

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
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
        for (const id of SENDER_IDS) {
          const sender = clients.get(id);
          if (sender) send(sender, { type: "receiver-ready" });
        }
        for (const id of SENDER_IDS) {
          if (clients.has(id)) send(ws, { type: "sender-connected", id });
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
});

const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 4242;
server.listen(PORT, "0.0.0.0", () => {
  const lanIp = ips.find((ip) => ip !== "127.0.0.1") ?? "localhost";
  console.log(`\nScreenshare running on https://${lanIp}:${PORT}`);
  console.log(`\n  Device A:   https://${lanIp}:${PORT}/sender.html?id=device-a`);
  console.log(`  Device B:   https://${lanIp}:${PORT}/sender.html?id=device-b`);
  console.log(`  TV:         https://${lanIp}:${PORT}/receiver.html`);
  console.log(
    `\n  ⚠  Click "Advanced" → "Proceed" on each device to bypass the self-signed cert warning.\n`,
  );
});

function onServerError(err: NodeJS.ErrnoException): void {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Set PORT= to use another.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
// ws re-emits the http server's 'error' on the WebSocketServer instance, so a
// listen failure (e.g. EADDRINUSE) surfaces there — handle both to be safe.
server.on("error", onServerError);
wss.on("error", onServerError);
