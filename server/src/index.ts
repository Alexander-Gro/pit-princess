// Pit Princess signaling server: WebSocket signaling + floor control, and static hosting of the phone PWA.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomHub, type Conn } from './rooms.ts';
import { createIceProvider } from './ice.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DEV_HTTPS = process.env.DEV_HTTPS === '1';
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? join(here, '../../phone/dist'));

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MSGS = 300;
const HEARTBEAT_MS = 15_000;
const MAX_CONNS_PER_IP = 20;
const ICE_REFRESH_MS = 3 * 3600_000;

const ice = createIceProvider();
const ACCESS_KEY = process.env.ACCESS_KEY ?? '';
const hub = new RoomHub({ getIceServers: ice.get, accessKey: ACCESS_KEY });

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

/** Base URL the phone should open. */
function publicUrl(): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (DEV_HTTPS) return `https://${lanAddress() ?? 'localhost'}:${HTTPS_PORT}`;
  return `http://localhost:${PORT}`;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = normalize(join(STATIC_DIR, rel));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    // Unknown paths fall back to the app shell
    file = join(STATIC_DIR, 'index.html');
  }
  try {
    const body = await readFile(file);
    const ext = extname(file);
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Phone app not built. Run: npm run build:phone');
  }
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (path === '/api/info') {
    res
      .writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ publicUrl: publicUrl() }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  void serveStatic(req, res);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws: WebSocket) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  const conn: Conn = {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => ws.close(),
  };

  let windowStart = Date.now();
  let count = 0;

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - windowStart > RATE_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }
    if (++count > RATE_MAX_MSGS) {
      ws.close(1008, 'rate limit');
      return;
    }
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      conn.send({ t: 'error', code: 'bad_message' });
      return;
    }
    hub.handle(conn, parsed).catch((e) => console.error('[hub]', e));
  });
  ws.on('close', () => hub.disconnect(conn));
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

const iceRefresh = setInterval(() => void hub.refreshIce().catch(() => {}), ICE_REFRESH_MS);
iceRefresh.unref();

const connsPerIp = new Map<string, number>();

function clientIp(req: IncomingMessage): string {
  // Behind Render/Fly the real client is the first X-Forwarded-For hop. Elsewhere the header is spoofable.
  if (!(process.env.TRUST_PROXY === '1' || process.env.RENDER || process.env.FLY_APP_NAME)) {
    return req.socket.remoteAddress || 'unknown';
  }
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if ((req.url ?? '').split('?')[0] !== '/ws') {
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  const n = connsPerIp.get(ip) ?? 0;
  if (n >= MAX_CONNS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  connsPerIp.set(ip, n + 1);
  // Count on the raw socket so rejected handshakes (which never reach the callback) free their slot too
  socket.once('close', () => {
    const left = (connsPerIp.get(ip) ?? 1) - 1;
    if (left <= 0) connsPerIp.delete(ip);
    else connsPerIp.set(ip, left);
  });
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

const http = createHttpServer(onRequest);
http.on('upgrade', onUpgrade);
http.listen(PORT, () => {
  console.log(`[pit-princess] http on :${PORT}  ICE: ${ice.describe}`);
  console.log(`[pit-princess] phone URL base: ${publicUrl()}`);
  console.log(`[pit-princess] access key: ${ACCESS_KEY ? 'required' : 'NOT set (open server; fine for localhost)'}`);
});

if (DEV_HTTPS) {
  void (async () => {
    const { key, cert } = await devCert();
    const https = createHttpsServer({ key, cert }, onRequest);
    https.on('upgrade', onUpgrade);
    https.listen(HTTPS_PORT, () => console.log(`[pit-princess] https (self-signed) on :${HTTPS_PORT}`));
  })();
}

/** Self-signed cert for LAN testing: phones only allow the microphone on HTTPS pages. */
async function devCert(): Promise<{ key: string; cert: string }> {
  const dir = resolve(here, '../certs');
  const keyFile = join(dir, 'dev-key.pem');
  const certFile = join(dir, 'dev-cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) {
    return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
  }
  const selfsigned = (await import('selfsigned')).default;
  const lan = lanAddress();
  const altNames: { type: number; value?: string; ip?: string }[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  if (lan) altNames.push({ type: 7, ip: lan });
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Pit Princess dev' }], {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile, pems.private);
  writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}
