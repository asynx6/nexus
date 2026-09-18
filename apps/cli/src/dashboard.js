// nexus dashboard — zero-dep live dashboard server.
// Serves static files + SSE event stream for real-time agent activity.
// Usage: nexus dashboard [--port=8484]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = resolve(__dirname, '..', '..', '..', 'packages', 'event-system', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function mimeFor(p) {
  return MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
}

function safeJoin(root, requested) {
  const target = resolve(root, '.' + requested);
  if (!target.startsWith(root)) return null;
  return target;
}

/** Parse simple argv shape: ['--port=8484'] → { port: 8484 } */
export function parseDashboardArgs(argv) {
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const v = eq > 0 ? a.slice(eq + 1) : true;
      const n = Number(v);
      flags[k] = Number.isFinite(n) && v !== '' ? n : v;
    }
  }
  return flags;
}

/**
 * Start the dashboard HTTP server.
 * Returns the server instance (caller must close it).
 * @param {Object} opts
 * @param {number} opts.port
 * @param {boolean} [opts.silent]
 * @param {string} [opts.publicDir] override the static files root
 * @param {{info, warn, error}} [opts.log]
 * @param {() => AsyncIterable<{event:string,data:any}>} [opts.eventSource]
 */
export async function startDashboard({ port = 8484, silent = false, publicDir = DEFAULT_PUBLIC_DIR, log = console, eventSource = null } = {}) {
  if (!existsSync(publicDir) || !statSync(publicDir).isDirectory()) {
    throw new Error(`dashboard public dir not found: ${publicDir}`);
  }

  const sseClients = new Set();
  function broadcast(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { /* drop dead client */ }
    }
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');

    if (u.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => { sseClients.delete(res); });
      return;
    }

    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: sseClients.size }));
      return;
    }

    let target;
    if (u.pathname === '/' || u.pathname === '/index.html') {
      target = join(publicDir, 'index.html');
    } else {
      const safe = safeJoin(publicDir, u.pathname);
      if (!safe) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      target = safe;
    }

    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': mimeFor(target) });
    res.end(readFileSync(target));
  });

  // Pipe event source into SSE clients if provided.
  let stopped = false;
  if (eventSource && typeof eventSource[Symbol.asyncIterator] === 'function') {
    (async () => {
      try {
        for await (const ev of eventSource()) {
          if (stopped) break;
          if (ev && ev.event) broadcast(ev.event, ev.data ?? ev);
          else if (ev && ev.kind) broadcast(ev.kind, ev);
        }
      } catch (e) {
        if (!silent) log.warn?.('event source ended:', e.message);
      }
    })();
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, () => {
      server.off('error', rejectListen);
      const addr = server.address();
      if (!silent) log.info?.(`dashboard listening on http://localhost:${addr.port}`);
      resolveListen();
    });
  });

  const close = () => {
    stopped = true;
    for (const res of sseClients) { try { res.end(); } catch {} }
    sseClients.clear();
    return new Promise((r) => server.close(() => r()));
  };
  server.closeGracefully = close;
  return server;
}
