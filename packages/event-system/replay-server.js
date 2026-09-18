// @nexus/event-system replay-server — tiny static HTTP server for the
// browser-based event timeline UI. Zero deps (Node http + fs + path only).
//
// Endpoints:
//   GET  /                          -> public/index.html (or directory listing fallback)
//   GET  /<file>                    -> static file from publicDir (whitelisted extensions)
//   GET  /api/events?subject=&since=&limit=&follow=1
//       -> JSON array of events; with follow=1, server-sent events stream (text/event-stream)
//   GET  /api/events/raw           -> newline-delimited JSON of all stored events
//   GET  /api/healthz              -> { ok: true, count, since }
//   GET  /api/ping                 -> pong
//
// Construction:
//   const { createReplayServer } = require('./replay-server.js');
//   const srv = createReplayServer({ store, publicDir, host, port });
//   await srv.listen();
//   await srv.close();
//
// `store` must expose an async iterable replay({ subject, since, limit }) plus
// count() — EventStore satisfies this directly.
import { createServer } from 'node:http';
import { statSync, createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const STATIC_EXTS = new Set(['.html', '.js', '.css', '.svg', '.png', '.ico', '.json', '.txt', '.map']);
const MAX_BODY = 1 << 20; // 1 MiB cap on request lines; we never accept bodies anyway

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

/** Parse a URL search string into an object. Duplicate keys collapse to last value. */
export function parseSearch(url) {
  const q = url.indexOf('?');
  if (q === -1) return {};
  const out = {};
  for (const pair of url.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
    catch { /* ignore malformed */ }
  }
  return out;
}

/** Route a single HTTP request. Exported for unit tests. */
export async function handle(req, res, { store, publicDir }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'allow': 'GET, HEAD', 'content-type': 'text/plain' }, 'method not allowed');
  }
  const path = (req.url || '/').split('?')[0] || '/';
  const q = parseSearch(req.url || '/');

  if (path === '/api/healthz') {
    return json(res, 200, { ok: true, count: store.count(), since: q.since ?? null });
  }
  if (path === '/api/ping') return json(res, 200, { pong: true });

  if (path === '/api/events' || path === '/api/events/') {
    const filter = {};
    if (q.subject) filter.subject = q.subject;
    if (q.since !== undefined) {
      const n = Number(q.since);
      if (Number.isFinite(n)) filter.since = n;
    }
    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (Number.isFinite(n)) filter.limit = n;
    }

    if (q.follow === '1' || q.follow === 'true') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
      let cursor = filter.since ?? 0;
      try {
        for (;;) {
          const batch = [];
          for await (const env of store.replay({ ...filter, since: cursor })) {
            batch.push(env);
            cursor = (env.seq ?? cursor) + 1;
          }
          for (const env of batch) res.write(`data: ${JSON.stringify(env)}\n\n`);
          if (batch.length === 0) res.write(`: idle\n\n`);
          if (req.socket.destroyed) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (e) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ message: e?.message ?? String(e) })}\n\n`); } catch {}
      } finally {
        clearInterval(ping);
        try { res.end(); } catch {}
      }
      return;
    }
    const out = [];
    for await (const env of store.replay(filter)) out.push(env);
    return json(res, 200, out);
  }

  if (path === '/api/events/raw' || path === '/api/events/raw/') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    try {
      for await (const env of store.replay({})) res.write(JSON.stringify(env) + '\n');
    } finally { try { res.end(); } catch {} }
    return;
  }

  // static files
  let rel = path === '/' ? '/index.html' : path;
  if (rel.includes('..')) return send(res, 400, { 'content-type': 'text/plain' }, 'bad path');
  const safe = normalize(rel).replace(/^[/\\]+/, '');
  const abs = resolve(join(publicDir, safe));
  if (!abs.startsWith(resolve(publicDir) + '/') && abs !== resolve(publicDir)) {
    return send(res, 400, { 'content-type': 'text/plain' }, 'bad path');
  }
  const ext = extname(abs).toLowerCase();
  if (!STATIC_EXTS.has(ext)) return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.txt':  'text/plain; charset=utf-8',
    '.map':  'application/json; charset=utf-8',
  };
  if (req.method === 'HEAD') return send(res, 200, { 'content-type': types[ext] ?? 'application/octet-stream', 'content-length': statSync(abs).size }, '');
  res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'content-length': statSync(abs).size });
  createReadStream(abs).pipe(res);
  return undefined;
}

/** Create a running http.Server bound to {host, port}. */
export function createReplayServer({ store, publicDir, host = '127.0.0.1', port = 9090 } = {}) {
  if (!store) throw new TypeError('store required');
  if (!publicDir) throw new TypeError('publicDir required');
  const server = createServer((req, res) => {
    // guard against slowloris-style stalls
    req.socket.setTimeout(60_000);
    handle(req, res, { store, publicDir }).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err?.message ?? String(err) });
      else try { res.end(); } catch {}
    });
  });
  return {
    server,
    host, port,
    listen() {
      return new Promise((resolveFn, reject) => {
        const onErr = (e) => reject(e);
        server.once('error', onErr);
        server.listen(port, host, () => { server.off('error', onErr); resolveFn(server.address()); });
      });
    },
    close() {
      return new Promise((resolveFn, reject) => server.close((e) => e ? reject(e) : resolveFn()));
    },
  };
}
