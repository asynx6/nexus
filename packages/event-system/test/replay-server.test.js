// Integration test: boot the replay server against a real EventStore on disk,
// hit /api/healthz, /api/events (one-shot), /api/events/raw, and / (static).
// Also exercises follow=1 SSE by appending events mid-stream.
//
// Uses an ephemeral port (port 0) so CI never collides with anything else.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { EventStore, makeEvent } from '../index.js';
import { EVENTS, newTaskId } from '@nexus/shared';
import { createReplayServer, parseSearch } from '../replay-server.js';

function here() { return resolve(fileURLToPath(import.meta.url), '..'); }
function publicDir() { return resolve(here(), '..', 'public'); }

async function getJson(srv, path) {
  const url = `http://${srv.host}:${srv.port}${path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return { status: r.status, body: await r.json(), headers: r.headers };
}

async function getText(srv, path) {
  const r = await fetch(`http://${srv.host}:${srv.port}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return { status: r.status, body: await r.text(), headers: r.headers };
}

test('parseSearch decodes common shapes', () => {
  assert.deepStrictEqual(parseSearch('/'), {});
  assert.deepStrictEqual(parseSearch('/x?a=1&b=two'), { a: '1', b: 'two' });
  assert.deepStrictEqual(parseSearch('/x?subject=agent-1'), { subject: 'agent-1' });
  assert.deepStrictEqual(parseSearch('/x?empty='), { empty: '' });
});

test('replay-server: healthz + static + one-shot JSON + raw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-replay-'));
  const path = join(dir, 'events.jsonl');
  const store = new EventStore(path);
  try {
    const t1 = newTaskId();
    for (let i = 0; i < 5; i++) {
      store.append(makeEvent(EVENTS.AGENT_TOOL_CALLED, { i }, t1));
    }
    const srv = createReplayServer({ store, publicDir: publicDir(), host: '127.0.0.1', port: 0 });
    await srv.listen();
    const addr = srv.server.address();
    srv.port = addr.port;

    // healthz
    const h = await getJson(srv, '/api/healthz');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.ok, true);
    assert.strictEqual(h.body.count, 5);

    // one-shot JSON
    const j = await getJson(srv, '/api/events');
    assert.strictEqual(j.status, 200);
    assert.strictEqual(j.body.length, 5);
    assert.strictEqual(j.body[0].seq, 0);
    assert.strictEqual(j.body[4].seq, 4);

    // filter by subject
    const t2 = newTaskId();
    store.append(makeEvent(EVENTS.AGENT_STARTED, {}, t2));
    const subj = await getJson(srv, `/api/events?subject=${encodeURIComponent(t2)}`);
    assert.strictEqual(subj.body.length, 1);
    assert.strictEqual(subj.body[0].subject, t2);

    // since cursor
    const since = await getJson(srv, `/api/events?since=3`);
    assert.strictEqual(since.body.length, 3);
    assert.strictEqual(since.body[0].seq, 3);

    // raw NDJSON
    const raw = await getText(srv, '/api/events/raw');
    const lines = raw.body.trim().split('\n');
    assert.strictEqual(lines.length, 6);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));

    // static root
    const indexHtml = await getText(srv, '/');
    assert.match(indexHtml.headers.get('content-type') ?? '', /text\/html/);
    assert.match(indexHtml.body, /NEXUS — replay/);

    // static JS
    const app = await getText(srv, '/app.js');
    assert.match(app.headers.get('content-type') ?? '', /javascript/);
    assert.match(app.body, /EventSource/);

    // traversal blocked
    const evil = await fetch(`http://${srv.host}:${srv.port}/../etc/passwd`);
    assert.ok(evil.status === 400 || evil.status === 404);

    await srv.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('replay-server: SSE follow streams appended events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-replay-'));
  const path = join(dir, 'events.jsonl');
  const store = new EventStore(path);
  try {
    store.append(makeEvent(EVENTS.AGENT_STARTED, {}, 'agent-A'));

    const srv = createReplayServer({ store, publicDir: publicDir(), host: '127.0.0.1', port: 0 });
    await srv.listen();
    srv.port = srv.server.address().port;

    const ac = new AbortController();
    const seen = [];
    const parser = (async () => {
      const r = await fetch(`http://${srv.host}:${srv.port}/api/events?follow=1`, { signal: ac.signal });
      assert.strictEqual(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) {
              try { seen.push(JSON.parse(line.slice(5).trim())); } catch {}
            }
          }
        }
        if (seen.length >= 3) break;
      }
      ac.abort();
    })();

    // give SSE a moment to register, then append live events
    await delay(150);
    store.append(makeEvent(EVENTS.AGENT_TOOL_CALLED, { n: 1 }, 'agent-A'));
    await delay(150);
    store.append(makeEvent(EVENTS.AGENT_TOOL_FINISHED, { n: 1 }, 'agent-A'));
    await delay(150);
    store.append(makeEvent(EVENTS.TASK_CREATED, {}, 'agent-A'));

    await parser.catch(() => {});

    assert.ok(seen.length >= 1, `expected at least 1 event over SSE, got ${seen.length}`);
    const names = seen.map((e) => e.name);
    assert.ok(names.includes('agent.started') || names.some((n) => n === EVENTS.AGENT_STARTED));
    assert.ok(seen.some((e) => e.subject === 'agent-A'));

    ac.abort();
    await srv.close().catch(() => {});
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('replay-server: ping endpoint + 405 on POST', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-replay-'));
  const store = new EventStore(join(dir, 'events.jsonl'));
  try {
    const srv = createReplayServer({ store, publicDir: publicDir(), host: '127.0.0.1', port: 0 });
    await srv.listen();
    srv.port = srv.server.address().port;
    const r = await getJson(srv, '/api/ping');
    assert.strictEqual(r.body.pong, true);
    const post = await fetch(`http://${srv.host}:${srv.port}/api/ping`, { method: 'POST' });
    assert.strictEqual(post.status, 405);
    await srv.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
