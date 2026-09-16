import { test } from 'node:test';
import assert from 'node:assert';
import { EVENTS, EVENT_SCHEMA_VERSION } from '../events.js';
import { newAgentId, newSandboxId, newTaskId, newEventId, newId } from '../ids.js';
import { loadEnv } from '../env.js';
import { makeLogger } from '../log.js';

test('event taxonomy frozen and complete vs plan §11', () => {
  for (const need of ['agent.created', 'agent.tool_called', 'sandbox.created', 'file.modified', 'terminal.finished', 'task.completed', 'memory.created', 'artifact.created']) {
    assert.ok(Object.values(EVENTS).includes(need), 'missing ' + need);
  }
  assert.throws(() => { EVENTS.AGENT_CREATED = 'x'; }, 'EVENTS must be frozen');
  assert.strictEqual(EVENT_SCHEMA_VERSION, 1);
});

test('event envelope serializes deterministically (round-trip)', () => {
  const evt = { id: newEventId(), ts: new Date('2026-01-01T00:00:00Z').toISOString(), name: EVENTS.TASK_CREATED, subject: newTaskId(), data: { title: 'fib' } };
  const s = JSON.stringify(evt);
  const back = JSON.parse(s);
  assert.deepStrictEqual(back, evt);
  assert.match(evt.id, /^evt-[0-9a-f]{8}$/);
});

test('ids unique + prefixed correctly', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const a = newAgentId();
    assert.match(a, /^agent-[0-9a-f]{8}$/);
    assert.ok(!seen.has(a), 'collision at ' + i);
    seen.add(a);
  }
  assert.match(newSandboxId(), /^sandbox-/);
  assert.match(newId('foo'), /^foo-[0-9a-f]{8}$/);
});

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('loadEnv parses file, never overrides existing env, returns keys only', () => {
  const f = join(process.cwd(), '.env.test-tmp');
  writeFileSync(f, 'NEXUS_TEST_A=hello\n#comment\nNEXUS_TEST_B="quoted value"\nBROKEN\n');
  process.env.NEXUS_TEST_B = 'preexisting';
  const keys = loadEnv(f);
  assert.strictEqual(process.env.NEXUS_TEST_A, 'hello');
  assert.strictEqual(process.env.NEXUS_TEST_B, 'preexisting', 'explicit env wins');
  assert.strictEqual(JSON.stringify(keys).includes('quoted value'), false, 'values must not leak through return');
  rmSync(f);
});
