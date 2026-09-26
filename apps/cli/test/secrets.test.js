// `nexus secrets` (E1) — full vault lifecycle against a tmp dir. No network.
// The passphrase is injected via env so no stdin interaction is needed.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSecrets } from '../src/secrets.js';

const PASS = 'test-passphrase';
const WRONG = 'wrong-passphrase';

let out = [];
const stdout = (s) => out.push(String(s));
const stderr = (s) => out.push(String(s));
function reset() { out = []; }

function envFor(dir) {
  return { NEXUS_PROJECT_PASSPHRASE: PASS, NEXUS_PROJECT_SECRETS_FILE: join(dir, 'secrets.enc') };
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-secret-'));
  return { dir, env: envFor(dir) };
}

async function run(env, argv, flags = {}) {
  reset();
  const code = await runSecrets(argv, env, stdout, stderr, { flags });
  return { code, text: out.join('\n') };
}

test('init creates a mode-600 empty vault', async () => {
  const { dir, env } = project();
  const r = await run(env, ['init']);
  assert.strictEqual(r.code, 0);
  assert.ok(/vault created/.test(r.text));
  const p = join(dir, 'secrets.enc');
  assert.ok(existsSync(p));
  assert.strictEqual(statSync(p).mode & 0o777, 0o600);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  assert.strictEqual(doc.version, 1);
  assert.deepStrictEqual(doc.entries, {});
  rmSync(dir, { recursive: true, force: true });
});

test('init refuses to clobber an existing vault', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  const r = await run(env, ['init']);
  assert.strictEqual(r.code, 2);
  assert.ok(/already exists/.test(r.text));
  rmSync(dir, { recursive: true, force: true });
});

test('set + get + list round-trip; values never appear in list output', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  let r = await run(env, ['set', 'OPENAI_API_KEY'], { value: 'sk-super-secret' });
  assert.strictEqual(r.code, 0);
  assert.ok(/stored: OPENAI_API_KEY/.test(r.text));

  r = await run(env, ['list']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.text.includes('OPENAI_API_KEY'));
  assert.ok(!r.text.includes('sk-super-secret'), 'value leaked into list');

  r = await run(env, ['get', 'OPENAI_API_KEY']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.text.includes('sk-super-secret'));

  rmSync(dir, { recursive: true, force: true });
});

test('ciphertext on disk is not the plaintext', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  await run(env, ['set', 'DB_PASSWORD'], { value: 'hunter2' });
  const blob = readFileSync(join(dir, 'secrets.enc'), 'utf8');
  assert.ok(!blob.includes('hunter2'), 'plaintext stored at rest');
  rmSync(dir, { recursive: true, force: true });
});

test('wrong passphrase cannot read the vault', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  await run(env, ['set', 'TOKEN'], { value: 'val' });
  const bad = { ...env, NEXUS_PROJECT_PASSPHRASE: WRONG };
  const r = await run(bad, ['get', 'TOKEN']);
  assert.strictEqual(r.code, 1);
  assert.ok(/decrypt failed/.test(r.text));
  rmSync(dir, { recursive: true, force: true });
});

test('get/rm on a missing name exits non-zero', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  let r = await run(env, ['get', 'NOPE']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no entry named NOPE/.test(r.text));
  r = await run(env, ['rm', 'NOPE']);
  assert.strictEqual(r.code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('rm removes an entry', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  await run(env, ['set', 'GONE'], { value: 'v' });
  const r = await run(env, ['rm', 'GONE']);
  assert.strictEqual(r.code, 0);
  const doc = JSON.parse(readFileSync(join(dir, 'secrets.enc'), 'utf8'));
  assert.deepStrictEqual(doc.entries, {});
  rmSync(dir, { recursive: true, force: true });
});

test('grant + revoke round-trip; grants persist in a mode-600 sidecar', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  await run(env, ['set', 'API_KEY'], { value: 'v' });

  let r = await run(env, ['grant', 'agent-1', 'API_KEY']);
  assert.strictEqual(r.code, 0);
  assert.ok(/agent-1 may read API_KEY/.test(r.text));
  const gp = join(dir, 'secrets.enc.grants');
  assert.ok(existsSync(gp));
  assert.strictEqual(statSync(gp).mode & 0o777, 0o600);
  assert.deepStrictEqual(JSON.parse(readFileSync(gp, 'utf8')), { 'agent-1': ['API_KEY'] });

  r = await run(env, ['revoke', 'agent-1', 'API_KEY']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(readFileSync(gp, 'utf8')), {});

  rmSync(dir, { recursive: true, force: true });
});

test('grant on a name absent from the vault is refused', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  const r = await run(env, ['grant', 'agent-1', 'GHOST']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no entry named GHOST/.test(r.text));
  rmSync(dir, { recursive: true, force: true });
});

test('operations without a vault fail with an actionable hint', async () => {
  const { dir, env } = project();
  const r = await run(env, ['list']);
  assert.strictEqual(r.code, 1);
  assert.ok(/run `nexus secrets init` first/.test(r.text));
  rmSync(dir, { recursive: true, force: true });
});

test('unknown subcommand shows help', async () => {
  const { dir, env } = project();
  const r = await run(env, ['bogus']);
  assert.strictEqual(r.code, 2);
  assert.ok(/unknown subcommand/.test(r.text));
  rmSync(dir, { recursive: true, force: true });
});

test('empty passphrase is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-secret-'));
  // process.stdin.isTTY is false under the test runner, so ask() bails with
  // the actionable message instead of blocking on a dead stdin.
  const r = await run({ NEXUS_PROJECT_SECRETS_FILE: join(dir, 'secrets.enc') }, ['init']);
  assert.strictEqual(r.code, 1);
  assert.ok(/NEXUS_PROJECT_PASSPHRASE required/.test(r.text), `unexpected output: ${r.text}`);
  rmSync(dir, { recursive: true, force: true });
});

test('name validation: lowercase names are refused', async () => {
  const { dir, env } = project();
  await run(env, ['init']);
  const r = await run(env, ['set', 'lowercase'], { value: 'v' });
  assert.strictEqual(r.code, 1);
  rmSync(dir, { recursive: true, force: true });
});
