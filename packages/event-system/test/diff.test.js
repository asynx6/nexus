// Tests for replay diff (TASK-LEONARS-B3).
//   node --test packages/event-system/test/diff.test.js
//
// Covers: identical runs, modified payload, added/removed steps, reordered
// steps, event with no identity fields (name-only alignment), summarize,
// determinism on symmetric inputs, and that real event names from the
// taxonomy align by tool+target, not by outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRuns, diffPayload, keyFor, summarize } from '../src/diff.js';

// Synthetic envelope factory mirroring the store shape { id, ts, name, subject, data, seq }.
function ev(name, data, extra = {}) {
  return { id: 'id-' + Math.random().toString(36).slice(2), ts: '2026-09-26T00:00:00Z', name, subject: 'run', data, ...extra };
}

test('keyFor: name + identity fields, outcome fields excluded', () => {
  const k1 = keyFor(ev('agent.tool_called', { tool: 'fs.read', path: '/tmp/a', ms: 10 }));
  const k2 = keyFor(ev('agent.tool_called', { tool: 'fs.read', path: '/tmp/a', ms: 999, ok: false }));
  assert.equal(k1, k2, 'same tool+path must share identity despite different outcome');
  const k3 = keyFor(ev('agent.tool_called', { tool: 'fs.read', path: '/tmp/b' }));
  assert.notEqual(k1, k3, 'different path = different identity');
});

test('keyFor: falls back to name alone when data is empty or outcome-only', () => {
  assert.equal(keyFor(ev('agent.task_start', {})), 'agent.task_start');
  assert.equal(keyFor(ev('agent.task_start', { ok: true, ms: 5 })), 'agent.task_start');
});

test('keyFor: object fields compare order-independent, arrays are ordered', () => {
  // Object keys are unordered; arrays are sequences — a reordered list of
  // steps is a different identity, not the same one.
  assert.equal(keyFor(ev('x.y', { cfg: { z: 1, y: 2 } })), keyFor(ev('x.y', { cfg: { y: 2, z: 1 } })));
  assert.notEqual(keyFor(ev('x.y', { tags: ['b', 'a'] })), keyFor(ev('x.y', { tags: ['a', 'b'] })));
});

test('diffRuns: identical runs produce all "same", summarize.identical true', () => {
  const a = [ev('agent.task_start', { task: 'fib' }), ev('agent.tool_called', { tool: 'fs.write', path: '/f' }), ev('agent.task_done', { result: [1] })];
  const ops = diffRuns(a, a.map((e) => ({ ...e, id: 'other', seq: e.seq + 1 })));
  assert.deepEqual(ops.map((o) => o.op), ['same', 'same', 'same']);
  const s = summarize(ops);
  assert.equal(s.identical, true);
  assert.equal(s.same, 3);
});

test('diffRuns: changed outcome is one "mod" with field changes, not remove+add', () => {
  const a = [ev('agent.tool_finished', { tool: 'fs.write', ok: true, ms: 10 })];
  const b = [ev('agent.tool_finished', { tool: 'fs.write', ok: false, ms: 20, errorText: 'EACCES' })];
  const ops = diffRuns(a, b);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'mod');
  const fields = ops[0].changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ['errorText', 'ms', 'ok']);
  assert.equal(ops[0].changes.find((c) => c.field === 'ok').from, true);
  assert.equal(ops[0].changes.find((c) => c.field === 'ok').to, false);
  assert.equal(summarize(ops).identical, false);
});

test('diffRuns: extra step in right run is "added", in left run is "removed"', () => {
  const a = [ev('agent.task_start', { task: 't' }), ev('agent.task_done', { result: 1 })];
  const b = [ev('agent.task_start', { task: 't' }), ev('agent.tool_called', { tool: 'fs.read', path: '/f' }), ev('agent.task_done', { result: 1 })];
  assert.deepEqual(diffRuns(a, b).map((o) => o.op), ['same', 'added', 'same']);
  assert.deepEqual(diffRuns(b, a).map((o) => o.op), ['same', 'removed', 'same']);
});

test('diffRuns: inserted + modified + dropped together align the shared spine', () => {
  const a = [
    ev('agent.task_start', { task: 'fib' }),
    ev('agent.tool_called', { tool: 'fs.write', path: '/f.py' }),
    ev('agent.tool_finished', { tool: 'fs.write', ok: true }),
    ev('agent.task_done', { result: [0, 1, 1] }),
  ];
  const b = [
    ev('agent.task_start', { task: 'fib' }),
    ev('agent.tool_called', { tool: 'fs.write', path: '/f.py' }),
    ev('agent.tool_finished', { tool: 'fs.write', ok: false, errorText: 'ENOSPC' }),
    ev('agent.tool_called', { tool: 'terminal.exec', cmd: 'python /f.py' }),
    ev('agent.task_done', { result: [0, 1, 2] }),
  ];
  const ops = diffRuns(a, b);
  assert.deepEqual(ops.map((o) => o.op), ['same', 'same', 'mod', 'added', 'mod']);
  const s = summarize(ops);
  assert.equal(s.mod, 2); assert.equal(s.added, 1); assert.equal(s.removed, 0);
  assert.equal(s.identical, false);
});

test('diffRuns: reordered steps do not collapse into "same"', () => {
  const a = [ev('agent.tool_called', { tool: 'fs.read', path: '/a' }), ev('agent.tool_called', { tool: 'fs.read', path: '/b' })];
  const b = [ev('agent.tool_called', { tool: 'fs.read', path: '/b' }), ev('agent.tool_called', { tool: 'fs.read', path: '/a' })];
  const ops = diffRuns(a, b);
  const s = summarize(ops);
  assert.equal(s.identical, false, 'reordering must not be reported as identical');
  assert.ok(s.same < 2, 'a full reordering cannot match every step');
  assert.ok(s.added >= 1 && s.removed >= 1, 'reorder surfaces as add/remove pairs');
});

test('diffRuns: empty inputs are safe', () => {
  assert.deepEqual(diffRuns([], []), []);
  assert.deepEqual(diffRuns([], [ev('a.b', {})]).map((o) => o.op), ['added']);
  assert.deepEqual(diffRuns([ev('a.b', {})], []).map((o) => o.op), ['removed']);
});

test('diffRuns: non-array inputs are coerced, not thrown', () => {
  assert.deepEqual(diffRuns(null, undefined), []);
  assert.deepEqual(summarize(diffRuns(null, undefined)), { same: 0, mod: 0, added: 0, removed: 0, total: 0, identical: true });
});

test('diffRuns: ops preserve run order (walk is left-to-right)', () => {
  const a = [ev('a.x', { n: 1 }), ev('a.y', { n: 2 })];
  const b = [ev('a.y', { n: 2 }), ev('a.x', { n: 1 }), ev('a.z', { n: 3 })];
  const ops = diffRuns(a, b);
  // LCS is [a.y] (length 1): a.x drops out of the left run, and both a.x and
  // a.z appear on the right as additions.
  const s = summarize(ops);
  assert.equal(s.same, 1);
  assert.equal(s.removed, 1);
  assert.equal(s.added, 2);
  assert.equal(ops[0].op, 'removed', 'walk is left-to-right: unmatched left event emits first');
  assert.equal(ops[1].op, 'same');
});

test('diffRuns: large identical runs stay O(n) memory-friendly and fast', () => {
  const n = 4000;
  const a = Array.from({ length: n }, (_, i) => ev('agent.tool_called', { tool: 'fs.read', path: `/f${i}` }));
  const ops = diffRuns(a, a);
  assert.equal(summarize(ops).same, n);
});

test('diffPayload: empty for equal payloads, lists nested diffs', () => {
  assert.deepEqual(diffPayload(ev('a.b', { x: 1 }), ev('a.b', { x: 1 })), []);
  const c = diffPayload(ev('a.b', { cfg: { a: 1, b: 2 } }), ev('a.b', { cfg: { a: 9, b: 2 } }));
  assert.equal(c.length, 1);
  assert.equal(c[0].field, 'cfg');
});

test('summarize: counts every op kind', () => {
  const ops = [{ op: 'same' }, { op: 'same' }, { op: 'mod' }, { op: 'added' }, { op: 'removed' }];
  const s = summarize(ops);
  assert.deepEqual(s, { same: 2, mod: 1, added: 1, removed: 1, total: 5, identical: false });
});

test('diffRuns: deterministic on the same input twice', () => {
  const a = [ev('a.x', { n: 1 }), ev('a.y', { n: 2 })];
  const b = [ev('a.y', { n: 3 }), ev('a.z', { n: 1 })];
  assert.deepEqual(diffRuns(a, b), diffRuns(a, b));
});
