// Tiny HTTP router (Node built-in http). No deps. Methods + pattern paths.
// handler(req, res, ctx) -> void|Promise<void>. 404 if nothing matches.

import { timingSafeEqual } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** Parse ":id" segments from a pattern into a params dict. */
function matchPath(pattern, urlPath) {
  const p = pattern.split('/').filter(Boolean);
  const u = urlPath.split('/').filter(Boolean);
  if (p.length !== u.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(u[i]);
    else if (p[i] !== u[i]) return null;
  }
  return params;
}

/** Read the request body as JSON (cap at 256 KiB). Throws on bad JSON. */
async function readJson(req, maxBytes = 256 * 1024) {
  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response with status. */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Build an http request handler from a { method, pattern, handler } table.
 * @param {Array<{ method: string, pattern: string,
 *   handler: (ctx: Ctx) => Promise<void>|void }>} routes
 * @param {{ notFound?: (res) => void }} [opts]
 */
export function createRouter(routes, opts = {}) {
  const table = routes.filter((r) => SAFE_METHODS.has(r.method));
  return async (req, res) => {
    if (!SAFE_METHODS.has(req.method)) {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    for (const r of table) {
      if (r.method !== req.method) continue;
      const params = matchPath(r.pattern, url.pathname);
      if (!params) continue;
      let body = {};
      try { body = await readJson(req); } catch (e) {
        sendJson(res, 400, { error: 'bad_request', message: e.message });
        return;
      }
      const ctx = { params, query: url.searchParams, body, req, res };
      try {
        await r.handler(ctx);
      } catch (e) {
        if (res.headersSent) return; // SSE handler already streaming; bail
        sendJson(res, 500, { error: 'internal_error', message: e.message });
      }
      return;
    }
    if (opts.notFound) return opts.notFound(res);
    sendJson(res, 404, { error: 'not_found' });
  };
}

/** Constant-time string compare to defeat timing oracles on the API token. */
export function safeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
