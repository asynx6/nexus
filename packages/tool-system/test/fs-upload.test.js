import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fsTools } from '../src/tools/fs.js';

// Fake sandbox runtime — records exec/copyIn calls, no Docker needed.
function fakeRuntime() {
  const execs = [];
  const files = new Map();
  return {
    execs,
    files,
    async exec(_id, cmd) {
      execs.push(cmd.join(' '));
      const joined = cmd.join(' ');
      if (joined.startsWith('test -f ')) {
        const p = cmd[2];
        return { exitCode: files.has(p) ? 0 : 1, stdout: '', stderr: '' };
      }
      if (joined.startsWith('base64 -w0 ')) {
        const p = cmd[2];
        const b = files.get(p);
        if (!b) return { exitCode: 1, stdout: '', stderr: 'no file' };
        return { exitCode: 0, stdout: b.toString('base64'), stderr: '' };
      }
      if (joined.startsWith('cat ')) {
        const p = cmd[1];
        const b = files.get(p);
        if (!b) return { exitCode: 1, stdout: '', stderr: 'no file' };
        return { exitCode: 0, stdout: b.toString('utf8'), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async copyIn(_id, entries) {
      for (const e of entries) files.set(e.path, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content));
    },
  };
}

function ctxWith(runtime) {
  return { runtime, sandboxId: 'sbx1', bus: null, agentId: 't' };
}

test('fs.download returns base64 of a binary file', async () => {
  const rt = fakeRuntime();
  await rt.copyIn('sbx1', [{ path: '/tmp/a.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]);
  const tools = fsTools();
  const dl = tools.find((t) => t.name === 'fs.download');
  const out = await dl.handler({ path: '/tmp/a.png' }, ctxWith(rt));
  assert.equal(out.encoding, 'base64');
  assert.equal(out.content, 'iVBORw==');
  assert.equal(out.path, '/tmp/a.png');
});

test('fs.download errors on a missing file', async () => {
  const rt = fakeRuntime();
  const dl = fsTools().find((t) => t.name === 'fs.download');
  await assert.rejects(() => dl.handler({ path: '/tmp/nope' }, ctxWith(rt)), /no such file/);
});

test('fs.upload writes base64 content as raw bytes', async () => {
  const rt = fakeRuntime();
  const up = fsTools().find((t) => t.name === 'fs.upload');
  const out = await up.handler({ path: '/tmp/b.bin', content: 'iVBORw==' }, ctxWith(rt));
  assert.equal(out.bytes, 4);
  assert.deepEqual([...rt.files.get('/tmp/b.bin')], [0x89, 0x50, 0x4e, 0x47]);
});

test('fs.upload rejects empty and oversized content', async () => {
  const rt = fakeRuntime();
  const up = fsTools().find((t) => t.name === 'fs.upload');
  await assert.rejects(() => up.handler({ path: '/tmp/x', content: '' }, ctxWith(rt)), /content is required/);
  const big = 'A'.repeat(12_000_000);
  await assert.rejects(() => up.handler({ path: '/tmp/x', content: big }, ctxWith(rt)), /8 MiB/);
});

test('upload then download round-trips binary', async () => {
  const rt = fakeRuntime();
  const up = fsTools().find((t) => t.name === 'fs.upload');
  const dl = fsTools().find((t) => t.name === 'fs.download');
  const src = Buffer.from([0x00, 0xff, 0x10, 0x20, 0x30]);
  await up.handler({ path: '/tmp/rt.bin', content: src.toString('base64') }, ctxWith(rt));
  const out = await dl.handler({ path: '/tmp/rt.bin' }, ctxWith(rt));
  assert.deepEqual(Buffer.from(out.content, 'base64'), src);
});

test('both tools are registered with correct permissions', () => {
  const names = fsTools().map((t) => t.name);
  assert.ok(names.includes('fs.download'));
  assert.ok(names.includes('fs.upload'));
  const dl = fsTools().find((t) => t.name === 'fs.download');
  const up = fsTools().find((t) => t.name === 'fs.upload');
  assert.equal(dl.permission, 'fs.read');
  assert.equal(up.permission, 'fs.write');
});
