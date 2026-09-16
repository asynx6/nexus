import { test } from 'node:test';
import assert from 'node:assert';
import { PermissionManager } from '../index.js';

test('deny-by-default: unknown agent and unknown tool both denied', () => {
  const pm = new PermissionManager();
  const a = pm.check('agent-1', 'fs.read');
  assert.strictEqual(a.allowed, false);
  assert.match(a.reason, /deny-by-default/);

  pm.grant('agent-1', 'fs.read', { paths: ['/workspace/**'] });
  const b = pm.check('agent-1', 'terminal.exec');
  assert.strictEqual(b.allowed, false);
  assert.match(b.reason, /not granted/);
});

test('fs path matcher: /** root covers children, siblings excluded', () => {
  const pm = new PermissionManager();
  pm.grant('agent-1', 'fs.write', { paths: ['/workspace/**'] });
  assert.strictEqual(pm.check('agent-1', 'fs.write', { path: '/workspace/a/b.txt' }).allowed, true);
  assert.strictEqual(pm.check('agent-1', 'fs.write', { path: '/etc/passwd' }).allowed, false);
  // /workspaces should NOT match /workspace/**
  assert.strictEqual(pm.check('agent-1', 'fs.write', { path: '/workspaces/x' }).allowed, false);
});

test('command allowlist is exact', () => {
  const pm = new PermissionManager();
  pm.grant('agent-1', 'terminal.exec', { commands: ['npm install', 'python main.py'] });
  assert.strictEqual(pm.check('agent-1', 'terminal.exec', { command: 'npm install' }).allowed, true);
  assert.strictEqual(pm.check('agent-1', 'terminal.exec', { command: 'rm -rf /' }).allowed, false);
  assert.strictEqual(pm.check('agent-1', 'terminal.exec', { command: 'npm publish' }).allowed, false);
});

test('network allowlist checks hostname of url', () => {
  const pm = new PermissionManager();
  pm.grant('agent-1', 'net.fetch', { hosts: ['api.example.com'] });
  assert.strictEqual(pm.check('agent-1', 'net.fetch', { url: 'https://api.example.com/v1' }).allowed, true);
  assert.strictEqual(pm.check('agent-1', 'net.fetch', { url: 'https://evil.com/' }).allowed, false);
  assert.strictEqual(pm.check('agent-1', 'net.fetch', { url: 'not a url' }).allowed, false);
});

test('revoke restores deny; check() output carries agent/tool/args for audit', () => {
  const pm = new PermissionManager();
  pm.grant('agent-1', 'fs.read');
  assert.deepStrictEqual(pm.listGrants('agent-1'), ['fs.read']);
  pm.revoke('agent-1', 'fs.read');
  assert.strictEqual(pm.check('agent-1', 'fs.read').allowed, false);
  const d = pm.check('agent-9', 'fs.read', { path: '/x' });
  assert.strictEqual(d.agentId, 'agent-9');
  assert.strictEqual(d.tool, 'fs.read');
  assert.deepStrictEqual(d.args, { path: '/x' });
});
