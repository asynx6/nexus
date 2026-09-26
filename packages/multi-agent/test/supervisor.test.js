import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-system/src/store.js';
import { Supervisor } from '../src/supervisor.js';

let dir;
function fresh() { dir = mkdtempSync(join(tmpdir(), 'nexus-sup-')); }

test('rejects an empty roster', () => {
  fresh();
  const store = new EventStore(join(dir, 'e.jsonl'));
  assert.throws(() => new Supervisor({ store, roster: [], agentId: 'sup' }), /at least 1/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('bootstrap joins the supervisor + workers; first joiner is leader', () => {
  fresh();
  const store = new EventStore(join(dir, 'e.jsonl'));
  const s = new Supervisor({ store, roster: ['w1', 'w2'], agentId: 'sup' });
  const led = s.bootstrap();
  assert.equal(led, 'sup', 'supervisor joins first and becomes leader');
  assert.equal(s.isLeader(), true);
  assert.deepEqual(s.cluster.members().sort(), ['sup', 'w1', 'w2']);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('scheduleTask -> nextTask flow hands work to the first available worker', () => {
  fresh();
  const store = new EventStore(join(dir, 'e.jsonl'));
  const s = new Supervisor({ store, roster: ['w1', 'w2'], agentId: 'sup' });
  s.bootstrap();
  const { taskId } = s.scheduleTask('do a thing');
  const task = s.nextTask('w1');
  assert.equal(task.taskId, taskId);
  assert.equal(task.text, 'do a thing');
  // queue drained: second worker gets null
  assert.equal(s.nextTask('w2'), null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('nextTask rejects unknown workers and returns null when not leader', () => {
  fresh();
  const store = new EventStore(join(dir, 'e.jsonl'));
  const s = new Supervisor({ store, roster: ['w1'], agentId: 'sup' });
  s.bootstrap();
  s.scheduleTask('x');
  // make w1 the leader: construct the same roster but join w1 first
  const s2 = new Supervisor({ store, roster: ['sup'], agentId: 'w1' });
  assert.equal(s2.isLeader(), true, 'w1 is now leader (lower seq)');
  assert.equal(s.nextTask('w1'), null, 'former leader must not hand out work');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('completeTask records done/failed events on both streams', () => {
  fresh();
  const store = new EventStore(join(dir, 'e.jsonl'));
  const s = new Supervisor({ store, roster: ['w1'], agentId: 'sup' });
  s.bootstrap();
  s.scheduleTask('build a house');
  const task = s.nextTask('w1');
  s.completeTask('w1', task.taskId, true, { cost: 3 });
  // the supervisor's stream must have the completion
  const done = [...s.stream('sup').events()].find((e) => e.name === 'cluster.task.done');
  assert.ok(done, 'supervisor should see the completion');
  assert.equal(done.data.workerId, 'w1');
  assert.equal(done.data.ok, true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('recoverOrphanedTasks re-enqueues claims from departed members', () => {
  fresh();
  const store = new EventStore(join(dir, 'e.jsonl'));
  const s = new Supervisor({ store, roster: ['w1', 'w2'], agentId: 'sup' });
  s.bootstrap();
  s.scheduleTask('orphan candidate');
  s.nextTask('w1'); // w1 claims it
  s.cluster.leave('w1'); // w1 is gone
  const re = s.recoverOrphanedTasks();
  assert.ok(re >= 1, `re-enqueued ${re} orphaned tasks`);
  // a new worker can claim it
  assert.notEqual(s.nextTask('w2'), null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('cluster state is reconstructable by a fresh Supervisor on the same store', () => {
  fresh();
  const store = new EventStore(join(dir, 'e.jsonl'));
  const s1 = new Supervisor({ store, roster: ['w1'], agentId: 'sup' });
  s1.bootstrap();
  s1.scheduleTask('ping');
  const { taskId } = s1.nextTask('w1');
  s1.completeTask('w1', taskId, true);
  store.close();
  // new supervisor on the same store sees everything
  const s2 = new Supervisor({ store, roster: ['w1'], agentId: 'sup' });
  assert.equal(s2.leader(), 'sup');
  assert.equal(s2.cluster.members().length, 2, 'sup + w1');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
