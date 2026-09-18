import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldProject, parseInitArgs } from '../src/init.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'nexus-init-'));
}

test('parseInitArgs: name + --yes', () => {
  const r = parseInitArgs(['my-app', '--yes']);
  assert.strictEqual(r.name, 'my-app');
  assert.strictEqual(r.yes, true);
});

test('parseInitArgs: defaults to --no when flag absent', () => {
  const r = parseInitArgs(['my-app']);
  assert.strictEqual(r.name, 'my-app');
  assert.strictEqual(r.yes, false);
});

test('parseInitArgs: rejects when name missing', () => {
  assert.throws(() => parseInitArgs([]), /project name required/);
});

test('parseInitArgs: rejects invalid name (path traversal / shell meta)', () => {
  assert.throws(() => parseInitArgs(['../etc']), /invalid project name/);
  assert.throws(() => parseInitArgs(['foo; rm -rf /']), /invalid project name/);
  assert.throws(() => parseInitArgs(['foo bar']), /invalid project name/);
});

test('scaffoldProject --yes writes expected skeleton', async () => {
  const cwd = freshDir();
  try {
    const target = join(cwd, 'my-app');
    const answers = {
      name: 'my-app',
      scope: '@my-scope',
      provider: 'hermes-agent',
      sandbox: 'subprocess',
    };
    await scaffoldProject({ target, answers, yes: true, stdout: () => {}, stderr: () => {} });

    assert.ok(existsSync(target), 'target dir created');
    assert.ok(existsSync(join(target, 'package.json')), 'package.json');
    assert.ok(existsSync(join(target, '.env.example')), '.env.example');
    assert.ok(existsSync(join(target, 'README.md')), 'README.md');
    assert.ok(existsSync(join(target, 'Dockerfile')), 'Dockerfile');
    assert.ok(existsSync(join(target, 'apps/cli')), 'apps/cli');
    assert.ok(existsSync(join(target, 'apps/cli/package.json')), 'apps/cli/package.json');
    assert.ok(existsSync(join(target, 'packages/shared')), 'packages/shared');

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.name, '@my-scope/my-app');
    assert.strictEqual(pkg.nexus?.provider, 'hermes-agent');
    assert.strictEqual(pkg.nexus?.sandbox, 'subprocess');

    const env = readFileSync(join(target, '.env.example'), 'utf8');
    assert.match(env, /NEXUS_GATEWAY_BASE=/);
    assert.match(env, /NEXUS_GATEWAY_KEY=/);
    assert.match(env, /NEXUS_GATEWAY_MODELS=hermes-agent/);

    const df = readFileSync(join(target, 'Dockerfile'), 'utf8');
    assert.match(df, /^FROM node:\d+/m);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('scaffoldProject rejects existing non-empty dir', async () => {
  const cwd = freshDir();
  try {
    const target = join(cwd, 'exists');
    const fs = await import('node:fs');
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, 'blocker.txt'), 'no');
    await assert.rejects(
      () => scaffoldProject({ target, answers: { name: 'exists', scope: '@s', provider: 'p', sandbox: 'subprocess' }, yes: true, stdout: () => {}, stderr: () => {} }),
      /already exists/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
