import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-system/src/store.js';
import { makeEvent } from '../../event-system/src/events.js';
import { Cluster } from '../src/cluster.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-cluster-'));
  const store = new EventStore(join(dir, 'events.jsonl'));
  // Close the store before the test's rmSync, or Windows EBUSY on the .idx
  // makes every test fail on this box (CI is Ubuntu and unaffected).
  return { store, dir, close: () => store.close() };
}

test('rejects a roster with fewer than 2 members or duplicates', () => {
  const mk = freshStore();
  assert.throws(() => new Cluster(mk.store, ['a']), /at least 2/);
  assert.throws(() => new Cluster(mk.store, ['a', 'a']), /unique/);
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('leader is the earliest-joined active member', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['b', 'a']);
  assert.equal(c.leader(), null, 'no members yet');
  c.join('b');
  c.join('a');
  assert.equal(c.leader(), 'b', 'b joined first');
  assert.equal(c.isLeader('b'), true);
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('leaving re-elects among survivors', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['a', 'b', 'c']);
  c.join('a');
  c.join('b');
  c.join('c');
  assert.equal(c.leader(), 'a');
  c.leave('a');
  assert.equal(c.leader(), 'b', 'b is next earliest survivor');
  assert.deepEqual(c.members().sort(), ['b', 'c']);
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('members() ignores joins from non-roster ids', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['a', 'b']);
  c.join('a');
  mk.store.append(makeEvent('cluster.join', { memberId: 'intruder' }, 'intruder'));
  assert.deepEqual(c.members(), ['a']);
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('join/leave reject unknown members', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['a', 'b']);
  assert.throws(() => c.join('z'), /unknown member/);
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('claimNext drains the queue and never reissues a claimed item', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['a', 'b']);
  c.enqueue('jobs', 'j1', { n: 1 });
  c.enqueue('jobs', 'j2', { n: 2 });
  assert.deepEqual(c.claimNext('a', 'jobs'), { id: 'j1', payload: { n: 1 }, seq: 0 });
  assert.deepEqual(c.claimNext('b', 'jobs'), { id: 'j2', payload: { n: 2 }, seq: 1 });
  assert.equal(c.claimNext('a', 'jobs'), null, 'queue drained');
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('queues are independent', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['a', 'b']);
  c.enqueue('jobs', 'j1', 1);
  c.enqueue('other', 'j1', 99);
  const got = c.claimNext('a', 'jobs');
  assert.equal(got.id, 'j1');
  assert.equal(c.claimNext('a', 'other').id, 'j1', 'same id, different queue is separate');
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('barrier resolves only when every active member reports', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['a', 'b', 'c']);
  c.join('a'); c.join('b'); c.join('c');
  assert.equal(c.barrier('a', 'phase1'), false);
  assert.equal(c.barrier('b', 'phase1'), false);
  assert.equal(c.barrier('c', 'phase1'), true, 'all three have reported');
  // duplicate report is a no-op and stays resolved
  assert.equal(c.barrier('a', 'phase1'), true);
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('barrier reflects current membership, not the full roster', () => {
  const mk = freshStore();
  const c = new Cluster(mk.store, ['a', 'b', 'c']);
  c.join('a'); c.join('b');
  c.leave('b'); // only a remains
  assert.equal(c.barrier('a', 'p'), true, 'sole active member completes alone');
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});

test('cluster state is reconstructable by a fresh Cluster on the same store', () => {
  const mk = freshStore();
  const c1 = new Cluster(mk.store, ['a', 'b']);
  c1.join('a'); c1.join('b'); c1.enqueue('q', 'x', 1);
  const c2 = new Cluster(mk.store, ['a', 'b']);
  assert.equal(c2.leader(), 'a');
  assert.deepEqual(c2.claimNext('b', 'q'), { id: 'x', payload: 1, seq: 2 });
  mk.close();
  rmSync(mk.dir, { recursive: true, force: true });
});
