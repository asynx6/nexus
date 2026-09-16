// @nexus/dashboard — minimal web dashboard (P11): overview over agents/sandboxes/
// tasks/events derived from the event stream. No framework — node:http only.
// Read-only: every view is a projection of EventStore.replay().
import { createServer as httpCreateServer } from 'node:http';

const NAME = '@nexus/dashboard';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>NEXUS Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;background:#0e1116;color:#e6e6e6}
h1{font-size:1.3rem} table{border-collapse:collapse;width:100%;margin-top:1rem}
td,th{border:1px solid #2a2f3a;padding:.35rem .6rem;text-align:left;font-size:.9rem}
th{background:#161b24} code{color:#8ab4f8}
#stats span{display:inline-block;margin-right:1.2rem}
</style></head>
<body>
<h1>NEXUS Dashboard <small>(<span id="store"></span>)</small></h1>
<div id="stats"></div>
<h2>Recent events</h2>
<table><thead><tr><th>seq</th><th>ts</th><th>name</th><th>subject</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
async function refresh(){
  const s = await (await fetch('/api/stats')).json();
  document.getElementById('store').textContent = s.store;
  document.getElementById('stats').innerHTML =
    'total events: <b>'+s.total+'</b> '+
    Object.entries(s.byName).map(([k,v])=>'<span>'+k+': '+v+'</span>').join('');
  const ev = await (await fetch('/api/events?limit=50')).json();
  document.getElementById('rows').innerHTML = ev.events.map(e=>
    '<tr><td>'+e.seq+'</td><td>'+e.ts+'</td><td><code>'+e.name+'</code></td><td>'+(e.subject??'')+'</td></tr>').join('');
}
refresh(); setInterval(refresh, 5000);
</script></body></html>`;

/**
 * Build the dashboard HTTP server.
 * @param {{ store: import('@nexus/event-system').EventStore, storeName?: string }} deps
 * @returns {import('node:http').Server}
 */
export function createDashboard({ store, storeName = 'eventstore' }) {
  if (!store || typeof store.replay !== 'function' || typeof store.count !== 'function') {
    throw new TypeError('createDashboard requires an EventStore-like { replay, count }');
  }

  /** Latest seq per subject + last event per subject — the "state" projection. */
  function snapshot() {
    const byName = {};
    const subjects = new Map(); // subject -> { seq, ts, last }
    let total = 0;
    let last = null;
    for (const e of store.replay()) {
      total++;
      byName[e.name] = (byName[e.name] ?? 0) + 1;
      last = e;
      if (e.subject) {
        subjects.set(e.subject, { subject: e.subject, seq: e.seq, ts: e.ts, last: e.name });
      }
    }
    return { total, byName, last, entities: [...subjects.values()] };
  }

  return httpCreateServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    try {
      if (url.pathname === '/api/events') {
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100));
        const filter = {};
        for (const k of ['name', 'subject']) {
          const v = url.searchParams.get(k);
          if (v !== null) filter[k] = v;
        }
        const events = [...store.replay(filter)].slice(-limit)
          .map((e) => ({ ...e, seq: e.seq ?? null }));
        res.end(JSON.stringify({ events }));
        return;
      }
      if (url.pathname === '/api/stats') {
        const s = snapshot();
        res.end(JSON.stringify({
          store: storeName,
          total: s.total,
          byName: s.byName,
          lastEvent: s.last ? { id: s.last.id, ts: s.last.ts, name: s.last.name } : null,
          entities: s.entities,
        }));
        return;
      }
      if (url.pathname === '/healthz') {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(PAGE);
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
  });
}

export { NAME };
