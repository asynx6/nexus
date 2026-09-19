// License server tests: store key lifecycle + HTTP API end-to-end (in-process).
// No network: start handler on a random port, hit it with fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LicenseStore, createLicenseKey, verifyLicenseKey } from '../src/store.js';
import { makeLicenseApi } from '../src/api.js';

const SECRET = randomBytes(32).toString('hex');
const ADMIN = 'admin-token-123';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'nexus-license-'));
}

async function startServer() {
  const dir = tmpDir();
  const store = new LicenseStore({ path: join(dir, 'lic.jsonl'), secret: SECRET });
  const api = makeLicenseApi({ store, adminSecret: ADMIN });
  const server = createServer(api);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base, dir };
}

test('createLicenseKey: generates valid signed key for each tier', () => {
  for (const tier of ['free', 'pro', 'enterprise']) {
    const key = createLicenseKey(SECRET, tier);
    assert.match(key, /^NEXUS-(FREE|PRO|ENTERPRISE)-[0-9A-F]{32}-[0-9a-f]{64}$/);
    const v = verifyLicenseKey(SECRET, key);
    assert.equal(v.ok, true);
    assert.equal(v.tier, tier);
  }
});

test('verifyLicenseKey: rejects malformed, wrong secret, tampered payload', () => {
  const key = createLicenseKey(SECRET, 'pro');
  assert.equal(verifyLicenseKey(SECRET + 'x', key).ok, false, 'wrong secret');
  // tamper body (change a hex char in the middle)
  const tampered = key.slice(0, 20) + (key[20] === 'A' ? 'B' : 'A') + key.slice(21);
  assert.equal(verifyLicenseKey(SECRET, tampered).ok, false, 'tampered body (bad sig)');
  assert.equal(verifyLicenseKey(SECRET, 'garbage').ok, false);
  assert.equal(verifyLicenseKey(SECRET, 'NEXUS-PRO-ABC').ok, false);
});

test('LicenseStore.issue + get + verify roundtrip', () => {
  const dir = tmpDir();
  try {
    const store = new LicenseStore({ path: join(dir, 'lic.jsonl'), secret: SECRET });
    const rec = store.issue('enterprise');
    assert.equal(store.get(rec.key).tier, 'enterprise');
    assert.equal(store.verify(rec.key).tier, 'enterprise');
    assert.equal(store.verify(rec.key).activated, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('LicenseStore.activate: single-device by default, allowMultiDevice on flag', () => {
  const dir = tmpDir();
  try {
    const store = new LicenseStore({ path: join(dir, 'lic.jsonl'), secret: SECRET });
    const k = store.issue('pro').key;
    assert.equal(store.activate(k, 'dev-a').ok, true);
    assert.equal(store.verify(k).activated, true);
    // second device without allowMultiDevice → denied
    assert.equal(store.activate(k, 'dev-b').ok, false);
    assert.equal(store.activate(k, 'dev-b', { allowMultiDevice: true }).ok, true);
    assert.equal(store.verify(k).activated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('LicenseStore.deactivate + revoke', () => {
  const dir = tmpDir();
  try {
    const store = new LicenseStore({ path: join(dir, 'lic.jsonl'), secret: SECRET });
    const k = store.issue('free').key;
    store.activate(k, 'dev-a');
    assert.equal(store.deactivate(k, 'dev-b').ok, false, 'deactivate wrong device');
    assert.equal(store.deactivate(k, 'dev-a').ok, true);
    assert.equal(store.verify(k).activated, false);
    store.revoke(k);
    assert.equal(store.verify(k).ok, false);
    assert.equal(store.verify(k).reason, 'revoked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP: GET /v1/tiers returns 3 tiers', async () => {
  const { server, base } = await startServer();
  try {
    const r = await fetch(base + '/v1/tiers');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.tiers.length, 3);
    assert.deepEqual(j.tiers.map((t) => t.tier), ['free', 'pro', 'enterprise']);
  } finally { server.close(); }
});

test('HTTP: activate + verify + deactivate lifecycle over the wire', async () => {
  const { store, server, base } = await startServer();
  try {
    const k = store.issue('pro').key;
    // activate
    const a = await fetch(base + '/v1/keys/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k, device: 'wire-dev' }),
    });
    assert.equal(a.status, 200);
    const aj = await a.json();
    assert.equal(aj.device, 'wire-dev');
    // verify
    const v = await fetch(base + '/v1/keys/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k }),
    });
    const vj = await v.json();
    assert.equal(vj.tier, 'pro');
    assert.equal(vj.activated, true);
    // deactivate
    const d = await fetch(base + '/v1/keys/deactivate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k, device: 'wire-dev' }),
    });
    assert.equal(d.status, 200);
    const v2 = await fetch(base + '/v1/keys/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k }),
    });
    assert.equal((await v2.json()).activated, false);
  } finally { server.close(); }
});

test('HTTP: verify rejects unknown/bad key', async () => {
  const { server, base } = await startServer();
  try {
    const bad = await fetch(base + '/v1/keys/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'NEXUS-PRO-' + 'A'.repeat(32) + '-' + 'b'.repeat(64) }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).reason, 'bad signature');
  } finally { server.close(); }
});

test('HTTP: issue + list require admin token (401 without)', async () => {
  const { server, base } = await startServer();
  try {
    const noAuth = await fetch(base + '/v1/keys/issue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'pro' }),
    });
    assert.equal(noAuth.status, 401);
    const noAuthList = await fetch(base + '/v1/keys');
    assert.equal(noAuthList.status, 401);
    // with admin
    const ok = await fetch(base + '/v1/keys/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-license-admin': ADMIN },
      body: JSON.stringify({ tier: 'pro', count: 2 }),
    });
    assert.equal(ok.status, 201);
    const okj = await ok.json();
    assert.equal(okj.keys.length, 2);
  } finally { server.close(); }
});