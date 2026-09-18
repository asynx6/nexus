// Unit tests for image.describe tool.
//
// Pattern: register the tool against a stub provider + stub runtime, then
// call handler() directly. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageTools } from '../src/tools/image.js';
import { ToolRegistry } from '../src/registry.js';

// Tiny 1x1 PNG (transparent). Hex bytes, base64.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64');
const TINY_JPEG_BYTES = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432', 'hex');

function makeProvider(response) {
  return {
    chat: async (messages, opts) => {
      return response ?? { model: opts?.model ?? 'fake-vision', content: 'a small transparent square', usage: { prompt_tokens: 100, completion_tokens: 8 } };
    },
  };
}

function makeRuntime({ cat = 'data', catFail = false } = {}) {
  return {
    exec: async (id, cmd) => {
      if (catFail) return { exitCode: 1, stdout: '', stderr: 'no such file', timedOut: false };
      if (cmd[0] === 'cat') return { exitCode: 0, stdout: cat, stderr: '', timedOut: false };
      if (cmd[0] === 'wc') return { exitCode: 0, stdout: '68 /tmp/x.png', stderr: '', timedOut: false };
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
}

test('image.describe: b64 input — sends to provider with image content', async () => {
  const provider = makeProvider();
  const tool = imageTools()[0];
  const ctx = { provider, agentId: 'agent-test' };
  const out = await tool.handler({ b64: TINY_PNG_BASE64, prompt: 'what is this?' }, ctx);
  assert.equal(out.description, 'a small transparent square');
  assert.equal(out.mime, 'image/png');
  assert.equal(out.source, 'b64');
  assert.equal(out.bytes, TINY_PNG_BYTES.length);
  assert.match(out.model, /fake|vision|hermes/);
});

test('image.describe: rejects when neither path nor b64 provided', async () => {
  const tool = imageTools()[0];
  await assert.rejects(
    () => tool.handler({}, { provider: makeProvider() }),
    /either path or b64/,
  );
});

test('image.describe: rejects when both path and b64 provided', async () => {
  const tool = imageTools()[0];
  await assert.rejects(
    () => tool.handler({ path: '/tmp/x.png', b64: TINY_PNG_BASE64 }, { provider: makeProvider() }),
    /pass path OR b64/,
  );
});

test('image.describe: rejects when provider missing', async () => {
  const tool = imageTools()[0];
  await assert.rejects(
    () => tool.handler({ b64: TINY_PNG_BASE64 }, {}),
    /requires ctx.provider/,
  );
});

test('image.describe: path input — reads from sandbox via runtime.exec', async () => {
  const provider = makeProvider();
  const tool = imageTools()[0];
  const ctx = {
    provider,
    runtime: makeRuntime({ cat: TINY_PNG_BYTES.toString('binary') }),
    sandboxId: 'sbx-fake',
    agentId: 'agent-test',
  };
  const out = await tool.handler({ path: '/tmp/x.png' }, ctx);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.source, 'path');
  assert.equal(out.bytes, TINY_PNG_BYTES.length);
});

test('image.describe: detects jpeg mime', async () => {
  const provider = makeProvider();
  const tool = imageTools()[0];
  const ctx = { provider, agentId: 'agent-test' };
  const out = await tool.handler({ b64: TINY_JPEG_BYTES.toString('base64') }, ctx);
  assert.equal(out.mime, 'image/jpeg');
});

test('image.describe: rejects unsupported format', async () => {
  const provider = makeProvider();
  const tool = imageTools()[0];
  const ctx = { provider, agentId: 'agent-test' };
  // 4 random bytes that don't match any magic number
  await assert.rejects(
    () => tool.handler({ b64: Buffer.from('deadbeefcafebabe1234567890abcdef', 'hex').toString('base64') }, ctx),
    /unsupported image format/,
  );
});

test('image.describe: rejects b64 too large', async () => {
  const provider = makeProvider();
  const tool = imageTools()[0];
  const ctx = { provider, agentId: 'agent-test' };
  // 5 MiB of zeros as base64 → > 4 MiB decoded
  const huge = Buffer.alloc(5 * 1024 * 1024, 0).toString('base64');
  await assert.rejects(
    () => tool.handler({ b64: huge }, ctx),
    /too large/,
  );
});

test('image.describe: rejects path with shell escape attempt', async () => {
  const provider = makeProvider();
  const tool = imageTools()[0];
  const ctx = { provider, runtime: makeRuntime(), sandboxId: 'sbx-fake' };
  await assert.rejects(
    () => tool.handler({ path: '/tmp/x; rm -rf /' }, ctx),
    /invalid path/,
  );
});

test('image.describe: rejects when sandbox file not found', async () => {
  const provider = makeProvider();
  const tool = imageTools()[0];
  const ctx = { provider, runtime: makeRuntime({ catFail: true }), sandboxId: 'sbx-fake' };
  await assert.rejects(
    () => tool.handler({ path: '/tmp/missing.png' }, ctx),
    /read failed/,
  );
});

test('image.describe: imageTools returns array of one tool named image.describe', () => {
  const tools = imageTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'image.describe');
  assert.equal(tools[0].permission, 'image.describe');
  assert.equal(tools[0].schema.type, 'object');
  assert.deepEqual(tools[0].schema.required, undefined); // schema uses XOR via handler check, not required
});

test('image.describe: registered via ToolRegistry — exposes schema + handler', () => {
  const reg = new ToolRegistry();
  reg.register(imageTools()[0]);
  const t = reg.get('image.describe');
  assert.ok(t);
  assert.equal(t.name, 'image.describe');
});

test('image.describe: passes model from args; default from env or fallback', async () => {
  let seenOpts = null;
  const provider = { chat: async (_messages, opts) => { seenOpts = opts; return { model: opts.model, content: 'ok' }; } };
  const tool = imageTools()[0];
  await tool.handler({ b64: TINY_PNG_BASE64, model: 'gpt-vision-x' }, { provider });
  assert.equal(seenOpts.model, 'gpt-vision-x');
  await tool.handler({ b64: TINY_PNG_BASE64 }, { provider, env: { NEXUS_VISION_MODEL: 'from-env' } });
  assert.equal(seenOpts.model, 'from-env');
  await tool.handler({ b64: TINY_PNG_BASE64 }, { provider });
  assert.equal(seenOpts.model, 'hermes-vision');
});
