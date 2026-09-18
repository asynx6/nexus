// nexus dashboard tests — static HTML/JS/CSS + SSE endpoint.
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..', '..', '..');
const PUBLIC_DIR = join(PKG_ROOT, 'packages', 'event-system', 'public');

function silence() {
  const noop = () => {};
  return { log: noop, info: noop, warn: noop, error: noop };
}

test('startDashboard: serves index.html on GET /', async () => {
  const srv = await startDashboard({ port: 0, silent: true, log: silence() });
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(r.status, 200);
    const ct = r.headers.get('content-type') ?? '';
    assert.match(ct, /text\/html/);
    const html = await r.text();
    assert.match(html, /<title>.*[Dd]ashboard.*<\/title>/);
  } finally {
    srv.close();
  }
});

test('startDashboard: serves dashboard.js with text/javascript', async () => {
  const srv = await startDashboard({ port: 0, silent: true, log: silence() });
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/dashboard.js`);
    assert.strictEqual(r.status, 200);
    const ct = r.headers.get('content-type') ?? '';
    assert.match(ct, /javascript/);
  } finally {
    srv.close();
  }
});

test('startDashboard: serves dashboard.css with text/css', async () => {
  const srv = await startDashboard({ port: 0, silent: true, log: silence() });
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/dashboard.css`);
    assert.strictEqual(r.status, 200);
    const ct = r.headers.get('content-type') ?? '';
    assert.match(ct, /text\/css/);
  } finally {
    srv.close();
  }
});

test('startDashboard: 404 on unknown path', async () => {
  const srv = await startDashboard({ port: 0, silent: true, log: silence() });
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/nope.txt`);
    assert.strictEqual(r.status, 404);
  } finally {
    srv.close();
  }
});

test('startDashboard: SSE endpoint at /events', async () => {
  const srv = await startDashboard({ port: 0, silent: true, log: silence() });
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/events`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
  } finally {
    srv.close();
  }
});
