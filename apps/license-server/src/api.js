// License server HTTP API.
// Routes (all JSON):
//   POST /v1/keys/activate     { key, device }   → activate
//   POST /v1/keys/deactivate   { key, device }   → deactivate
//   POST /v1/keys/verify       { key, device }   → verify + tier
//   GET  /v1/keys              (admin, x-license-admin) → list
//   POST /v1/keys/issue        { tier, count }   (admin) → issue keys
//   GET  /v1/tiers             → list tiers + descriptions
//
// Admin routes are gated by a separate ADMIN_SECRET passed via the
// `x-license-admin` header (or ?admin= query). Regular routes only need the
// license key itself.

import { timingSafeEqual } from 'node:crypto';

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function adminOk(req, adminSecret) {
  const header = req.headers['x-license-admin'] ?? '';
  const query = (req.url || '').split('?')[1] || '';
  const params = new URLSearchParams(query);
  const given = header || params.get('admin') || '';
  if (!adminSecret || !given) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(adminSecret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function tierInfo(tier) {
  return {
    tier,
    limits: tier === 'free' ? { keys: 1, agents: 2, tasksPerDay: 50 }
      : tier === 'pro' ? { keys: 5, agents: 20, tasksPerDay: 1000 }
      : { keys: 9999, agents: 0, tasksPerDay: 0 },
  };
}

export function makeLicenseApi({ store, adminSecret = process.env.LICENSE_ADMIN_SECRET || null }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://internal');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && path === '/v1/tiers') {
        return json(res, 200, {
          ok: true,
          tiers: ['free', 'pro', 'enterprise'].map(tierInfo),
        });
      }

      if (req.method === 'GET' && path === '/v1/keys') {
        if (!adminOk(req, adminSecret)) return json(res, 401, { ok: false, error: 'unauthorized' });
        return json(res, 200, { ok: true, keys: store.list() });
      }

      if (req.method === 'POST' && path === '/v1/keys/issue') {
        if (!adminOk(req, adminSecret)) return json(res, 401, { ok: false, error: 'unauthorized' });
        const body = await readBody(req);
        const tier = body.tier ?? 'pro';
        const count = Math.min(Number(body.count ?? 1), 100);
        if (!['free', 'pro', 'enterprise'].includes(tier)) return json(res, 400, { ok: false, error: 'bad tier' });
        const keys = [];
        for (let i = 0; i < count; i++) keys.push(store.issue(tier));
        return json(res, 201, { ok: true, keys });
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        const { key, device } = body;

        if (path === '/v1/keys/activate') {
          if (!key || !device) return json(res, 400, { ok: false, error: 'key and device required' });
          const r = store.activate(key, device, { allowMultiDevice: body.allowMultiDevice });
          return json(res, r.ok ? 200 : 400, r);
        }

        if (path === '/v1/keys/deactivate') {
          if (!key || !device) return json(res, 400, { ok: false, error: 'key and device required' });
          const r = store.deactivate(key, device);
          return json(res, r.ok ? 200 : 400, r);
        }

        if (path === '/v1/keys/verify') {
          if (!key) return json(res, 400, { ok: false, error: 'key required' });
          const v = store.verify(key);
          return json(res, v.ok ? 200 : 400, v);
        }

        return json(res, 404, { ok: false, error: 'not found' });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  };
}