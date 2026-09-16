import { test } from 'node:test';
import assert from 'node:assert';
import { AgentLoop } from '../src/loop.js';
import { EventBus, EVENTS } from '@nexus/event-system';

function fakeTools(log = []) {
  return {
    list: () => [{ name: 'fs.write', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }],
    execute: async (name, args) => { log.push({ name, args }); return { ok: true, output: 'wrote ' + args.path }; },
  };
}

test('rejects without provider/tools', () => {
  assert.throws(() => new AgentLoop({}), TypeError);
  assert.throws(() => new AgentLoop({ provider: { chat: async () => ({}) } }), TypeError);
});

test('simple answer: no tool call -> done immediately', async () => {
  const provider = { chat: async () => ({ content: '21', model: 'm1' }) };
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (e) => seen.push(e.name));
  const loop = new AgentLoop({ provider, tools: fakeTools(), bus });
  const r = await loop.run('fib(8)?', { agentId: 'agent-1' });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.answer, '21');
  assert.strictEqual(r.steps, 1);
  assert.ok(seen.includes(EVENTS.AGENT_STARTED));
  assert.ok(seen.includes(EVENTS.TASK_COMPLETED));
});

test('tool round-trip: model calls tool, then answers with tool output in history', async () => {
  const execLog = [];
  let turn = 0;
  const provider = { chat: async (msgs) => {
    turn++;
    if (turn === 1) return { model: 'm1', tool_call: { name: 'fs.write', arguments: { path: '/workspace/fib.py', content: 'print(1)' } } };
    // second turn must see the tool result appended
    const toolMsg = msgs.find((m) => m.role === 'tool');
    return { content: 'created: ' + toolMsg.output, model: 'm1' };
  } };
  const loop = new AgentLoop({ provider, tools: fakeTools(execLog) });
  const r = await loop.run('create fib', { agentId: 'agent-1' });
  assert.strictEqual(r.done, true);
  assert.match(r.answer, /created: wrote \/workspace\/fib\.py/);
  assert.strictEqual(execLog.length, 1);
  assert.strictEqual(execLog[0].name, 'fs.write');
});

test('permission denial feeds reason back to model, tool never executes', async () => {
  const execLog = [];
  let turn = 0;
  const provider = { chat: async () => (++turn === 1
    ? { model: 'm1', tool_call: { name: 'fs.write', arguments: { path: '/etc/shadow', content: 'x' } } }
    : { content: 'sorry, blocked', model: 'm1' }) };
  const perms = { check: (id, tool, args) => ({ agentId: id, tool, allowed: !args.path?.startsWith('/etc/'), reason: 'path outside workspace', args }) };
  const loop = new AgentLoop({ provider, tools: fakeTools(execLog), permissions: perms });
  const r = await loop.run('rm shadow', { agentId: 'agent-1' });
  assert.strictEqual(execLog.length, 0);
  assert.match(r.history.find((m) => m.role === 'tool').output, /PERMISSION DENIED/);
  assert.strictEqual(r.answer, 'sorry, blocked');
});

test('audit receives every check decision', async () => {
  const decisions = [];
  let turn = 0;
  const provider = { chat: async () => (++turn === 1 ? { model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/workspace/a' } } } : { content: 'ok', model: 'm' }) };
  const perms = { check: () => ({ allowed: true, reason: 'grant match' }) };
  const audit = { logDecision: (d) => decisions.push(d) };
  const loop = new AgentLoop({ provider, tools: fakeTools(), permissions: perms, audit });
  await loop.run('t', { agentId: 'agent-9' });
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].allowed, true);
});

test('tool crash -> error string fed back, loop recovers', async () => {
  let turn = 0;
  const provider = { chat: async (msgs) => (++turn === 1
    ? { model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/p' } } }
    : { content: 'saw: ' + msgs.find((m) => m.role === 'tool').output, model: 'm' }) };
  const tools = { list: () => [], execute: async () => { throw new Error('disk on fire'); } };
  const loop = new AgentLoop({ provider, tools });
  const r = await loop.run('t', { agentId: 'a' });
  assert.match(r.answer, /TOOL ERROR: disk on fire/);
});

test('maxSteps guard: endless tool caller returns done:false', async () => {
  const provider = { chat: async () => ({ model: 'm', tool_call: { name: 'fs.write', arguments: { path: '/x' } } }) };
  const loop = new AgentLoop({ provider, tools: fakeTools() });
  const r = await loop.run('t', { agentId: 'a', maxSteps: 3 });
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.steps, 3);
});

test('emitter failure never kills the run', async () => {
  const badBus = { emit: () => { throw new Error('bus down'); } };
  const loop = new AgentLoop({ provider: { chat: async () => ({ content: 'x', model: 'm' }) }, tools: fakeTools(), bus: badBus });
  const r = await loop.run('t', { agentId: 'a' });
  assert.strictEqual(r.answer, 'x');
});
