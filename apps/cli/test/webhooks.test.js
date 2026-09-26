// `nexus webhooks` CLI — every subcommand against an injected fetch stub.
// No real HTTP; the stub records requests and replays canned responses.

import { test } from 'node:test';
import assert from 'node:assert';
import { runWebhooks } from '../src/webhooks.js';

function makeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const key = [init.method, new URL(url).pathname].join(' ');
    const hit = routes[key];
    if (!hit) return { status: 404, text: async () => 'no route' };
    const body = hit.body;
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    return { status: hit.status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const ENV = { NEXUS_API_BASE: 'http://controlplane.local:4000', NEXUS_API_TOKEN: 'tok-cli' };
const lines = () => out;
let out = [];
const stdout = (s) => out.push(String(s));
const stderr = (s) => out.push(String(s));

function reset() { out = []; }

test('add + list round-trip against the control plane', async () => {
  const store = {};
  const fetch = makeFetch({
    'POST /webhooks': { status: 201, body: { id: 'hook-1', url: 'https://r.io/h', events: null } },
    'GET /webhooks': { status: 200, body: { webhooks: [{ id: 'hook-1', url: 'https://r.io/h', events: ['task.completed'], delivered: 3, failed: 0, paused: false }] } },
  });
  reset();
  let code = await runWebhooks(['add', 'https://r.io/h', '--secret=s'], ENV, stdout, stderr, fetch);
  assert.strictEqual(code, 0);
  assert.ok(/registered hook-1/.test(lines().join('\n')));
  assert.strictEqual(fetch.calls[0].init.headers.authorization, 'Bearer tok-cli');
  assert.deepStrictEqual(JSON.parse(fetch.calls[0].init.body), { url: 'https://r.io/h', events: null, secret: 's', description: null });
  assert.strictEqual(fetch.calls.length, 1, 'one request per invocation');

  reset();
  code = await runWebhooks(['list'], ENV, stdout, stderr, fetch);
  assert.strictEqual(code, 0);
  assert.ok(/hook-1  https:\/\/r\.io\/h  events=task\.completed/.test(lines().join('\n')));

  // fresh client per invocation so calls[0] is always the request under test
  const f2 = makeFetch({ 'POST /webhooks': { status: 201, body: { id: 'hook-1', url: 'https://r.io/h' } } });
  code = await runWebhooks(['add', 'https://r.io/h', '--events=task.completed,task.failed'], ENV, stdout, stderr, f2);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(JSON.parse(f2.calls[0].init.body).events, ['task.completed', 'task.failed']);
});

test('get shows detail, including the last error', async () => {
  const fetch = makeFetch({
    'GET /webhooks/hook-9': {
      status: 200,
      body: { id: 'hook-9', url: 'https://r.io/x', events: null, delivered: 1, failed: 2, lastStatus: 500, lastError: 'boom', description: 'prod pager' },
    },
  });
  reset();
  const code = await runWebhooks(['get', 'hook-9'], ENV, stdout, stderr, fetch);
  assert.strictEqual(code, 0);
  const text = lines().join('\n');
  assert.ok(/delivered:\s+1/.test(text));
  assert.ok(/lastError:  boom/.test(text));
  assert.ok(/description: prod pager/.test(text));
});

test('pause / resume / rm / test happy paths', async () => {
  const fetch = makeFetch({
    'PATCH /webhooks/hook-2': { status: 200, body: { id: 'hook-2' } },
    'DELETE /webhooks/hook-2': { status: 204, body: {} },
    'POST /webhooks/hook-2/test': { status: 202, body: { eventId: 'evt-t' } },
  });
  for (const [argv, want] of [
    [['pause', 'hook-2'], /paused hook-2/],
    [['resume', 'hook-2'], /resumed hook-2/],
    [['rm', 'hook-2'], /removed hook-2/],
    [['test', 'hook-2'], /sent test event evt-t to hook-2/],
  ]) {
    reset();
    const code = await runWebhooks(argv, ENV, stdout, stderr, fetch);
    assert.strictEqual(code, 0);
    assert.ok(want.test(lines().join('\n')));
  }
});

test('404 on the server side -> exit 1', async () => {
  const fetch = makeFetch({});
  for (const argv of [['get', 'hook-x'], ['pause', 'hook-x'], ['rm', 'hook-x'], ['test', 'hook-x']]) {
    reset();
    const code = await runWebhooks(argv, ENV, stdout, stderr, fetch);
    assert.strictEqual(code, 1, JSON.stringify(argv));
  }
});

test('missing url / id is a usage error (exit 2)', async () => {
  const fetch = makeFetch({ 'GET /webhooks': { status: 200, body: { webhooks: [] } } });
  reset();
  assert.strictEqual(await runWebhooks(['add'], ENV, stdout, stderr, fetch), 2);
  reset();
  assert.strictEqual(await runWebhooks(['get'], ENV, stdout, stderr, fetch), 2);
  reset();
  assert.strictEqual(await runWebhooks(['rm'], ENV, stdout, stderr, fetch), 2);
});

test('NEXUS_API_BASE unset -> usage error with help', async () => {
  reset();
  const code = await runWebhooks(['list'], {}, stdout, stderr, makeFetch({}));
  assert.strictEqual(code, 2);
  assert.ok(/NEXUS_API_BASE is not set/.test(lines().join('\n')));
});

test('unknown subcommand -> exit 2 with help', async () => {
  reset();
  const code = await runWebhooks(['nope'], ENV, stdout, stderr, makeFetch({}));
  assert.strictEqual(code, 2);
  assert.ok(/unknown subcommand/.test(lines().join('\n')));
});

test('empty list prints a hint, exit 0', async () => {
  const fetch = makeFetch({ 'GET /webhooks': { status: 200, body: { webhooks: [] } } });
  reset();
  const code = await runWebhooks(['list'], ENV, stdout, stderr, fetch);
  assert.strictEqual(code, 0);
  assert.ok(/no webhooks registered/.test(lines().join('\n')));
});

test('server error surfaces status + body, non-zero exit', async () => {
  const fetch = makeFetch({ 'GET /webhooks': { status: 500, body: { error: 'boom' } } });
  reset();
  const code = await runWebhooks(['list'], ENV, stdout, stderr, fetch);
  assert.strictEqual(code, 2);
  assert.ok(/webhooks list: 500/.test(lines().join('\n')));
});
