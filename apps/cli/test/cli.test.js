import { test } from 'node:test';
import assert from 'node:assert';
import { parseArgs, runNexusCli } from '../src/cli.js';

test('parseArgs: --flag=value', () => {
  const r = parseArgs(['run', 'write fib', '--max-steps=8', '--model', 'hermes-agent']);
  assert.strictEqual(r.cmd, 'run');
  assert.strictEqual(r.task, 'write fib');
  assert.strictEqual(r.flags['max-steps'], '8');
  assert.strictEqual(r.flags.model, 'hermes-agent');
});

test('parseArgs: bare flag', () => {
  const r = parseArgs(['healthz', '--quiet']);
  assert.strictEqual(r.cmd, 'healthz');
  assert.strictEqual(r.flags.quiet, true);
});

test('runNexusCli: help returns 0', async () => {
  let buf = '';
  const out = (s) => { buf += s + '\n'; };
  const code = await runNexusCli(['help'], {}, out, () => {});
  assert.strictEqual(code, 0);
  assert.match(buf, /Usage:/);
});

test('runNexusCli: unknown command returns 2', async () => {
  let err = '';
  const code = await runNexusCli(['frobnicate'], {}, () => {}, (s) => { err += s; });
  assert.strictEqual(code, 2);
  assert.match(err, /unknown command/);
});

test('runNexusCli: run without task returns 2', async () => {
  let err = '';
  const code = await runNexusCli(['run'], {}, () => {}, (s) => { err += s; });
  assert.strictEqual(code, 2);
  assert.match(err, /task text required/);
});

test('runNexusCli: healthz reports base + models without gateway call', async () => {
  let buf = '';
  const env = { NEXUS_GATEWAY_BASE: 'https://api.test/v1', NEXUS_GATEWAY_MODELS: 'm1,m2' };
  const code = await runNexusCli(['healthz'], env, (s) => { buf += s + '\n'; }, () => {});
  assert.strictEqual(code, 0);
  assert.match(buf, /base: https:\/\/api.test\/v1/);
  assert.match(buf, /models: m1,m2/);
});
