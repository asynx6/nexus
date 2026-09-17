// ctx tests — verify buildRunCtx wires permissions with trailing /** for prefix match.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunCtx } from '../src/ctx.js';

test('buildRunCtx: permissions grant fs.read/write/edit with trailing /**', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ctx-'));
  try {
    const ctx = await buildRunCtx({
      storeDir: dir + '/store',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'test-dummy',
      models: 'hermes-agent',
    });
    const cwd = process.cwd();
    // exact /workspace + cwd match
    assert.strictEqual(ctx.permissions.check('cli', 'fs.write', { path: '/workspace' }).allowed, true);
    assert.strictEqual(ctx.permissions.check('cli', 'fs.write', { path: cwd }).allowed, true);
    // descendant prefix match (the bug we just fixed)
    assert.strictEqual(ctx.permissions.check('cli', 'fs.write', { path: '/workspace/sub/dir/file.txt' }).allowed, true);
    assert.strictEqual(ctx.permissions.check('cli', 'fs.write', { path: cwd + '/foo/bar.js' }).allowed, true);
    // fs.read
    assert.strictEqual(ctx.permissions.check('cli', 'fs.read', { path: '/workspace/x' }).allowed, true);
    assert.strictEqual(ctx.permissions.check('cli', 'fs.edit', { path: cwd + '/y' }).allowed, true);
    // outside allowed roots
    assert.strictEqual(ctx.permissions.check('cli', 'fs.write', { path: '/etc/passwd' }).allowed, false);
    // terminal.exec unrestricted
    assert.strictEqual(ctx.permissions.check('cli', 'terminal.exec', { command: 'echo hi' }).allowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
