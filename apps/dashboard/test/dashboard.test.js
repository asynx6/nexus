import { test } from 'node:test';
import assert from 'node:assert';
import { NAME, createDashboard } from '../index.js';
import { EventStore } from '@nexus/event-system';
import { makeEvent } from '@nexus/event-system';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dashboard skeleton loads', () => {
  assert.strictEqual(NAME, '@nexus/dashboard');
});

test('createDashboard rejects non-store deps', () => {
  assert.throws(() => createDashboard({}), TypeError);
  assert.throws(() => createDashboard({ store: { count: () => 0 } }), TypeError);
});

test('dashboard serves HTML + API projections from a real EventStore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-dash-'));
  const store = new EventStore(join(dir, 'events.jsonl'));
  try {
    store.append(makeEvent('agent.created', { model: 'stub' }, 'agent-1'));
    store.append(makeEvent('task.created', { goal: 'fib' }, 'task-1'));
    store.append(makeEvent('agent.tool_call', { tool: 'fs.write' }, 'agent-1'));

    const srv = createDashboard({ store, storeName: 'test-store' });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const port = srv.address().port;

    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.deepStrictEqual(health, { ok: true });

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes('NEXUS Dashboard'));

    const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
    assert.strictEqual(stats.store, 'test-store');
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.byName['agent.created'], 1);
    assert.strictEqual(stats.byName['agent.tool_call'], 1);
    // entities projection: latest event per subject
    const subjects = stats.entities.map((e) => e.subject).sort();
    assert.deepStrictEqual(subjects, ['agent-1', 'task-1']);

    const filtered = await (await fetch(
      `http://127.0.0.1:${port}/api/events?name=agent.created`,
    )).json();
    assert.strictEqual(filtered.events.length, 1);
    assert.strictEqual(filtered.events[0].subject, 'agent-1');

    const all = await (await fetch(`http://127.0.0.1:${port}/api/events?limit=2`)).json();
    assert.strictEqual(all.events.length, 2); // tail, not head

    const nf = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.strictEqual(nf.status, 404);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
