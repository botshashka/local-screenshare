const express = require('express');
const { WebSocketServer } = require('ws');
const https = require('https');
const { execSync } = require('child_process');
const { networkInterfaces } = require('os');
const { readFileSync, mkdirSync, existsSync } = require('fs');
const path = require('path');

// Collect all local IPv4 addresses for the TLS SAN
const ips = ['127.0.0.1'];
for (const nets of Object.values(networkInterfaces())) {
  for (const net of nets) {
    if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  }
}
const san = ips.map(ip => `IP:${ip}`).join(',') + ',DNS:localhost';

// Generate cert once and persist it — TV only needs to accept it once
const certDir = path.join(__dirname, '.certs');
mkdirSync(certDir, { recursive: true });
const keyFile = `${certDir}/key.pem`;
const certFile = `${certDir}/cert.pem`;
if (!existsSync(keyFile) || !existsSync(certFile)) {
  console.log('Generating self-signed cert (one-time)…');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${keyFile} -out ${certFile}` +
    ` -sha256 -days 3650 -nodes -subj '/CN=screenshare'` +
    ` -addext "subjectAltName=${san}" 2>/dev/null`
  );
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/receiver.html'));

const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, app);
const wss = new WebSocketServer({ server });

// id -> WebSocket
const clients = new Map();

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let clientId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      clientId = msg.id;
      clients.set(clientId, ws);
      console.log(`[+] ${clientId}`);

      if (clientId === 'receiver') {
        for (const id of ['device-a', 'device-b']) {
          if (clients.has(id)) send(clients.get(id), { type: 'receiver-ready' });
        }
        for (const id of ['device-a', 'device-b']) {
          if (clients.has(id)) send(ws, { type: 'sender-connected', id });
        }
      } else {
        if (clients.has('receiver')) {
          send(clients.get('receiver'), { type: 'sender-connected', id: clientId });
          send(ws, { type: 'receiver-ready' });
        }
      }
      return;
    }

    if (msg.to && clients.has(msg.to)) {
      send(clients.get(msg.to), msg);
    }
  });

  ws.on('close', () => {
    if (!clientId) return;
    clients.delete(clientId);
    console.log(`[-] ${clientId}`);

    if (clientId === 'receiver') {
      for (const id of ['device-a', 'device-b']) {
        if (clients.has(id)) send(clients.get(id), { type: 'peer-disconnected', id: 'receiver' });
      }
    } else {
      if (clients.has('receiver')) {
        send(clients.get('receiver'), { type: 'peer-disconnected', id: clientId });
      }
    }
  });
});

const PORT = process.env.PORT || 4242;
server.listen(PORT, '0.0.0.0', () => {
  const lanIp = ips.find(ip => ip !== '127.0.0.1') || 'localhost';
  console.log(`\nScreenshare running on https://${lanIp}:${PORT}`);
  console.log(`\n  Device A:   https://${lanIp}:${PORT}/sender.html?id=device-a`);
  console.log(`  Device B:   https://${lanIp}:${PORT}/sender.html?id=device-b`);
  console.log(`  TV:      https://${lanIp}:${PORT}/receiver.html`);
  console.log(`\n  ⚠  Click "Advanced" → "Proceed" on each device to bypass the self-signed cert warning.\n`);
});
