// P12 memory tests — round-trip + filter + recall-hydrate + idempotency.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '@nexus/event-system';
import { Memory, openMemory } from '../src/memory.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mem-'));
  return { dir, path: join(dir, 'events.jsonl') };
}

function env(id, name, subject, ts, data = {}) {
  return {
    id, name, subject,
    ts: typeof ts === 'string' ? ts : new Date(ts).toISOString(),
    data,
  };
}

test('index + recall round-trip', async () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const mem = openMemory(store, dir);
  const a = env('a1', 'task.started', 'task-A', 1_000);
  const b = env('a2', 'tool.executed', 'task-A', 1_500);
  const c = env('a3', 'task.ended', 'task-A', 2_000);
  mem.index(a); mem.index(b); mem.index(c);
  const rows = mem.recall({ subject: 'task-A', limit: 10 });
  assert.strictEqual(rows.length, 3);
  // newest first
  assert.strictEqual(rows[0].id, 'a3');
  assert.strictEqual(rows[2].id, 'a1');
  mem.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
});

test('recall filtered by name + ts range', () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const mem = openMemory(store, dir);
  for (let i = 0; i < 10; i++) mem.index(env(`e${i}`, 'tool.executed', 's', 1_000 + i * 100));
  mem.index(env('x', 'task.started', 's', 1_500));
  assert.strictEqual(mem.count({ name: 'tool.executed' }), 10);
  assert.strictEqual(mem.count({ name: 'task.started' }), 1);
  const since = mem.recall({ name: 'tool.executed', sinceTs: 1_500 });
  assert.ok(since.every((r) => r.ts >= 1_500));
  mem.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});

test('idempotent: re-index same id is a no-op', () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const mem = openMemory(store, dir);
  const e = env('dup', 'x', 's', 100);
  assert.strictEqual(mem.index(e), true);
  assert.strictEqual(mem.index(e), false);
  assert.strictEqual(mem.count(), 1);
  mem.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});

test('indexBatch transaction', () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const mem = openMemory(store, dir);
  const batch = Array.from({ length: 50 }, (_, i) => env(`b${i}`, 'tool.executed', 'B', 1_000 + i));
  const n = mem.indexBatch(batch);
  assert.strictEqual(n, 50);
  assert.strictEqual(mem.count({ subject: 'B' }), 50);
  mem.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});

test('rebuild walks EventStore and indexes everything', async () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  await store.append(env('r1', 'task.started', 'X', 100, { k: 1 }));
  await store.append(env('r2', 'tool.executed', 'Y', 200, { k: 2 }));
  await store.append(env('r3', 'task.ended', 'X', 300, { k: 3 }));
  const mem = openMemory(store, dir);
  const n = await mem.rebuild();
  assert.strictEqual(n, 3);
  assert.strictEqual(mem.count({ subject: 'X' }), 2);
  assert.strictEqual(mem.count({ subject: 'Y' }), 1);
  mem.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
});

test('recallHydrated returns full envelopes newest-first', async () => {
  const { dir, path } = tmp();
  const store = new EventStore(path);
  const mem = openMemory(store, dir);
  await store.append(env('h1', 'tool.executed', 'T', 100, { payload: 1 }));
  await store.append(env('h2', 'tool.executed', 'T', 200, { payload: 2 }));
  await mem.rebuild();
  const out = [];
  for await (const e of mem.recallHydrated({ subject: 'T' })) out.push(e);
  assert.strictEqual(out.length, 2);
  // recall() is DESC by ts; recallHydrated yields in that DESC order
  assert.strictEqual(out[0].data.payload, 2);
  assert.strictEqual(out[1].data.payload, 1);
  mem.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
});
