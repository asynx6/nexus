import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskArgs, runAsk } from '../src/ask.js';

const OUT = () => { const lines = []; return { lines, log: (s) => lines.push(String(s)) }; };

test('parseAskArgs joins positional words into one question and reads flags', () => {
  const a = parseAskArgs(['what', 'is', '2+2', '--model=gpt-x', '--raw']);
  assert.equal(a.question, 'what is 2+2');
  assert.equal(a.flags.model, 'gpt-x');
  assert.equal(a.flags.raw, true);
});

test('empty question exits 2', async () => {
  const errs = [];
  const rc = await runAsk([], {}, () => {}, (s) => errs.push(s));
  assert.equal(rc, 2);
  assert.match(errs.join('\n'), /a question is required/);
});

test('missing API key exits 2 with a setup hint', async () => {
  const errs = [];
  const rc = await runAsk(['hi'], {}, () => {}, (s) => errs.push(s));
  assert.equal(rc, 2);
  assert.match(errs.join('\n'), /NEXUS_GATEWAY_KEY/);
});

test('a stubbed gateway returns the reply and exit 0', async () => {
  // Stub ModelProvider at the module level is not possible without imports
  // gymnastics, so exercise the happy path through a fake fetch: the provider
  // uses global fetch, so install one and run against a localhost URL.
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      model: 'hermes-agent',
      choices: [{ message: { content: '4' } }],
      usage: { total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const o = OUT();
  const rc = await runAsk(['what is 2+2'], { NEXUS_GATEWAY_KEY: 'k' }, o.log, () => {});
  assert.equal(rc, 0);
  assert.equal(o.lines.join('\n'), '4');
  assert.ok(calls.length === 1, 'exactly one gateway call');
  globalThis.fetch = undefined;
});

test('gateway error exits 1', async () => {
  globalThis.fetch = async () => new Response('{"error":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } });
  const errs = [];
  const rc = await runAsk(['hi'], { NEXUS_GATEWAY_KEY: 'k' }, () => {}, (s) => errs.push(s));
  assert.equal(rc, 1);
  assert.match(errs.join('\n'), /ask:/);
  globalThis.fetch = undefined;
});
