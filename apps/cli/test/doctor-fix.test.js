// nexus doctor --fix tests — auto-repair common setup issues.
// Tests cover: env file recreation, lockfile regeneration, permission fix.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctorFix } from '../src/doctor.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'nexus-fix-'));
}

function silence() {
  const noop = () => {};
  return { stdout: noop, stderr: noop };
}

test('runDoctorFix: recreates .env-gateway from .env.example when missing', async () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, '.env.example'), 'NEXUS_GATEWAY_BASE=https://x/v1\nNEXUS_GATEWAY_KEY=replace\n');
    const out = [];
    const result = await runDoctorFix({ cwd: dir, exec: () => '', ...silence(), stdout: (s) => out.push(s) });
    assert.ok(existsSync(join(dir, '.env-gateway')), '.env-gateway created');
    const stat = statSync(join(dir, '.env-gateway'));
    // 0o600 = mode 33152
    assert.strictEqual(stat.mode & 0o777, 0o600, '.env-gateway mode = 600');
    assert.match(result.summary, /create-env-gateway|\.env-gateway/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctorFix: chmod 600 existing .env-gateway if wrong perms', async () => {
  const dir = freshDir();
  try {
    const f = join(dir, '.env-gateway');
    writeFileSync(f, 'NEXUS_GATEWAY_KEY=x\n');
    chmodSync(f, 0o644);
    const result = await runDoctorFix({ cwd: dir, exec: () => '', ...silence() });
    const stat = statSync(f);
    assert.strictEqual(stat.mode & 0o777, 0o600, 'chmod to 600');
    assert.match(result.summary, /chmod-env-gateway|chmod/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctorFix: regenerates package-lock.json when missing via exec', async () => {
  const dir = freshDir();
  try {
    const calls = [];
    const fakeExec = (file, args) => {
      calls.push([file, args]);
      if (file === 'npm' && args[0] === 'install') writeFileSync(join(dir, 'package-lock.json'), '{}');
      return '';
    };
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    const result = await runDoctorFix({ cwd: dir, exec: fakeExec, ...silence() });
    assert.ok(existsSync(join(dir, 'package-lock.json')), 'lockfile present after fix');
    assert.deepEqual(calls, [['npm', ['install', '--package-lock-only', '--no-audit', '--no-fund']]]);
    assert.match(result.summary, /lockfile|regenerated/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctorFix: no-op when everything healthy', async () => {
  const dir = freshDir();
  try {
    const f = join(dir, '.env-gateway');
    writeFileSync(f, 'NEXUS_GATEWAY_KEY=x\n');
    chmodSync(f, 0o600);
    writeFileSync(join(dir, 'package.json'), '{}');
    const lockf = join(dir, 'package-lock.json');
    writeFileSync(lockf, '{}');
    const calls = [];
    const result = await runDoctorFix({ cwd: dir, exec: (f, a) => { calls.push([f, a]); return ''; }, ...silence() });
    assert.strictEqual(calls.length, 0, 'no exec calls when healthy');
    assert.match(result.summary, /no changes|already healthy|nothing to fix/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctorFix: idempotent — second run is no-op', async () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, '.env.example'), 'NEXUS_GATEWAY_KEY=x\n');
    let execCalls = 0;
    const fakeExec = () => { execCalls++; return ''; };
    const ctx = { cwd: dir, exec: fakeExec, ...silence() };
    await runDoctorFix(ctx);
    const second = await runDoctorFix(ctx);
    assert.strictEqual(execCalls, 0, 'no npm calls on idempotent run');
    assert.match(second.summary, /no changes|already healthy|nothing to fix/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctorFix: returns structured actions list', async () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, '.env.example'), 'NEXUS_GATEWAY_KEY=x\n');
    const result = await runDoctorFix({ cwd: dir, exec: () => '', ...silence() });
    assert.ok(Array.isArray(result.actions));
    assert.ok(result.actions.length >= 1);
    assert.ok(result.actions[0].name);
    assert.ok(typeof result.actions[0].ok === 'boolean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
