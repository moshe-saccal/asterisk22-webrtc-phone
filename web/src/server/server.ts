/**
 * Web phone server
 *
 *  - serves the built browser client over HTTPS (getUserMedia needs a secure context)
 *  - proxies the SIP WebSocket (wss://<host>/ws) to Asterisk (ws://asterisk:8088/ws),
 *    so the browser only has to trust a single origin/certificate
 *  - GET /api/config   directory + client settings (never exposes passwords)
 *  - GET /healthz      liveness + Asterisk reachability
 *  - optional plain-HTTP listener that redirects to HTTPS
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));

const env = process.env;
const config = {
  httpsPort: Number(env.HTTPS_PORT ?? 8443),
  httpPort: Number(env.HTTP_PORT ?? 8080),
  publicHttpsPort: env.PUBLIC_HTTPS_PORT ? Number(env.PUBLIC_HTTPS_PORT) : undefined,
  tlsCert: env.TLS_CERT ?? path.resolve(here, '../../../certs/server.crt'),
  tlsKey: env.TLS_KEY ?? path.resolve(here, '../../../certs/server.key'),
  asteriskWsUrl: new URL(env.ASTERISK_WS_URL ?? 'ws://127.0.0.1:8088/ws'),
  usersFile: env.USERS_FILE ?? path.resolve(here, '../../../users.json'),
  staticDir: path.resolve(env.STATIC_DIR ?? path.resolve(here, '../client')),
  sipDomain: env.SIP_DOMAIN ?? '',
  clientIceServers: parseIceServers(env.CLIENT_ICE_SERVERS),
  runAsUser: env.RUN_AS_USER ?? 'node',
};

const SERVICES = [
  { extension: '600', name: 'Echo test', description: 'Hear and see yourself — audio and video are reflected back' },
  { extension: '601', name: 'Playback test', description: 'Plays a greeting and the current time' },
  { extension: '602', name: 'Music on hold', description: 'Streams the hold music' },
  { extension: '603', name: 'DTMF test', description: 'Reads back the digits you press' },
  { extension: '700', name: 'Conference room', description: 'Video conference — video follows the active talker' },
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), speaker-selection=(self), fullscreen=(self)',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self' wss: ws:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'Strict-Transport-Security': 'max-age=15552000',
};

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function parseIceServers(raw: string | undefined): RTCIceServerLike[] {
  if (!raw || !raw.trim()) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value as RTCIceServerLike[];
  } catch {
    // fall through
  }
  console.warn('CLIENT_ICE_SERVERS is not a JSON array — ignoring it');
  return [];
}

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface DirectoryUser {
  extension: string;
  name: string;
  type: 'webrtc' | 'sip';
}

// --- directory (users.json without passwords; reloaded when the file changes)
let directoryCache: { mtimeMs: number; users: DirectoryUser[] } | undefined;

async function loadDirectory(): Promise<DirectoryUser[]> {
  try {
    const { mtimeMs } = statSync(config.usersFile);
    if (directoryCache && directoryCache.mtimeMs === mtimeMs) return directoryCache.users;
    const parsed = JSON.parse(await readFile(config.usersFile, 'utf8')) as { users?: Array<Record<string, unknown>> };
    const users: DirectoryUser[] = (parsed.users ?? []).map((u) => ({
      extension: String(u.extension),
      name: typeof u.name === 'string' && u.name.trim() ? u.name.trim() : String(u.extension),
      type: u.type === 'sip' ? 'sip' : 'webrtc',
    }));
    users.sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }));
    directoryCache = { mtimeMs, users };
    return users;
  } catch (error) {
    log(`cannot read ${config.usersFile}: ${(error as Error).message}`);
    return directoryCache?.users ?? [];
  }
}

// --- HTTP handlers ---------------------------------------------------------
function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), { 'Content-Type': MIME['.json']!, 'Cache-Control': 'no-store' });
}

function checkAsterisk(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(upstreamPort(), config.asteriskWsUrl.hostname);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }
  let filePath = path.resolve(config.staticDir, '.' + relative);
  if (filePath !== config.staticDir && !filePath.startsWith(config.staticDir + path.sep)) {
    send(res, 403, 'Forbidden');
    return;
  }

  let stats = safeStat(filePath);
  if (stats?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stats = safeStat(filePath);
  }
  if (!stats) {
    // Single-page app: unknown routes without a file extension get index.html.
    if (path.extname(relative)) {
      send(res, 404, 'Not found', { 'Content-Type': MIME['.txt']! });
      return;
    }
    filePath = path.join(config.staticDir, 'index.html');
    stats = safeStat(filePath);
    if (!stats) {
      send(res, 503, 'Client not built. Run "npm run build".', { 'Content-Type': MIME['.txt']! });
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = String(stats.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function safeStat(filePath: string) {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'https://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  switch (url.pathname) {
    case '/api/config': {
      sendJson(res, 200, {
        sipDomain: config.sipDomain,
        webSocketPath: '/ws',
        iceServers: config.clientIceServers,
        directory: await loadDirectory(),
        services: SERVICES,
      });
      return;
    }
    case '/healthz': {
      const asterisk = await checkAsterisk();
      sendJson(res, asterisk ? 200 : 503, { status: asterisk ? 'ok' : 'degraded', asterisk });
      return;
    }
    default:
      serveStatic(req, res, url.pathname);
  }
}

// --- SIP WebSocket proxy -----------------------------------------------------
function upstreamPort(): number {
  const { port, protocol } = config.asteriskWsUrl;
  return port ? Number(port) : protocol === 'wss:' ? 443 : 80;
}

let activeSockets = 0;

function proxyWebSocket(req: IncomingMessage, client: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'https://localhost');
  if (url.pathname !== '/ws') {
    client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const peer = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
  const target = config.asteriskWsUrl;
  const upstream = net.connect(upstreamPort(), target.hostname);
  let established = false;

  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };

  upstream.setNoDelay(true);
  upstream.setKeepAlive(true, 30_000);
  if (client instanceof net.Socket) {
    client.setNoDelay(true);
    client.setKeepAlive(true, 30_000);
  }

  upstream.once('connect', () => {
    established = true;
    activeSockets += 1;
    log(`ws open   ${peer} -> ${target.host}${target.pathname} (active: ${activeSockets})`);

    const lines = [`GET ${target.pathname}${url.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'x-forwarded-for' || lower === 'x-forwarded-proto') continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: ${target.host}`);
    lines.push(`X-Forwarded-For: ${req.socket.remoteAddress ?? ''}`);
    lines.push('X-Forwarded-Proto: https');
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  upstream.on('error', (error) => {
    if (!established) {
      log(`ws error  ${peer}: Asterisk unreachable (${error.message})`);
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    teardown();
  });
  client.on('error', teardown);
  upstream.on('close', () => client.destroy());
  client.on('close', () => {
    upstream.destroy();
    if (established) {
      established = false;
      activeSockets -= 1;
      log(`ws close  ${peer} (active: ${activeSockets})`);
    }
  });
}

// --- startup -----------------------------------------------------------------
function readTls(): { cert: Buffer; key: Buffer } {
  try {
    return { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) };
  } catch (error) {
    console.error(`Cannot read TLS certificate/key (${config.tlsCert}, ${config.tlsKey}): ${(error as Error).message}`);
    console.error('Run scripts/setup.sh (or scripts/gen-certs.sh) to create them.');
    process.exit(1);
  }
}

function dropPrivileges(): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || !config.runAsUser) return;
  try {
    process.setgid?.(config.runAsUser);
    process.setuid?.(config.runAsUser);
    log(`dropped privileges to "${config.runAsUser}"`);
  } catch (error) {
    log(`could not drop privileges to "${config.runAsUser}": ${(error as Error).message}`);
  }
}

const tls = readTls();
const httpsServer = createHttpsServer({ ...tls, minVersion: 'TLSv1.2' }, (req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    log(`request error: ${(error as Error).stack ?? String(error)}`);
    if (!res.headersSent) send(res, 500, 'Internal server error');
    else res.destroy();
  });
});
httpsServer.on('upgrade', proxyWebSocket);
httpsServer.on('tlsClientError', () => {
  // Browsers probing a self-signed certificate abort the handshake; not worth logging.
});

const listeners: Promise<void>[] = [
  new Promise((resolve) => httpsServer.listen(config.httpsPort, '0.0.0.0', resolve)),
];

if (config.httpPort > 0) {
  const redirectServer = createHttpServer((req, res) => {
    const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
    const port = config.publicHttpsPort ?? config.httpsPort;
    const location = `https://${host}${port === 443 ? '' : `:${port}`}${req.url ?? '/'}`;
    res.writeHead(301, { Location: location, 'Content-Type': 'text/plain' });
    res.end(`Moved to ${location}\n`);
  });
  listeners.push(new Promise((resolve) => redirectServer.listen(config.httpPort, '0.0.0.0', resolve)));
}

await Promise.all(listeners);
dropPrivileges();
log(`web phone listening on https://0.0.0.0:${config.httpsPort}` + (config.httpPort > 0 ? ` (http ${config.httpPort} redirects)` : ''));
log(`SIP WebSocket /ws -> ${config.asteriskWsUrl.href}; static files from ${config.staticDir}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    httpsServer.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
