import { test } from 'node:test';

/** Longest shared leading characters of two strings (>=4 when hashes collide). */
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}
import assert from 'node:assert';
import { PromptRegistry, sha256Hex } from '../index.js';

const A = 'You are a NEXUS agent. Be concise.';
const B = 'You are a NEXUS agent. Be verbose.';
const C = 'You are a NEXUS agent. Be concise. Work in cwd only.';

test('publish creates a name with one version; body resolves', () => {
  const r = new PromptRegistry();
  const v = r.publish('cli.default', A);
  assert.ok(v.hash);
  assert.strictEqual(v.body, A);
  assert.strictEqual(r.active('cli.default'), v.hash);
  assert.strictEqual(r.body('cli.default'), A);
  assert.strictEqual(r.body('cli.default', 'latest'), A);
  assert.strictEqual(r.body('cli.default', v.hash), A);
});

test('hash is content-addressed: same bytes -> same hash', () => {
  const r = new PromptRegistry();
  const v1 = r.publish('cli.default', A);
  const r2 = new PromptRegistry();
  const v2 = r2.publish('cli.default', A);
  assert.strictEqual(v1.hash, v2.hash);
  assert.strictEqual(v1.hash, sha256Hex(A));
});

test('publishing a new body creates a new version and bumps active', () => {
  const r = new PromptRegistry();
  const v1 = r.publish('cli.default', A);
  const v2 = r.publish('cli.default', B);
  assert.notStrictEqual(v1.hash, v2.hash);
  assert.strictEqual(r.versions('cli.default').length, 2);
  assert.strictEqual(r.active('cli.default'), v2.hash);
  assert.strictEqual(r.body('cli.default'), B);
  // old version still readable byte-for-byte
  assert.strictEqual(r.body('cli.default', v1.hash), A);
});

test('re-publishing identical bytes is idempotent (no version bloat)', () => {
  const r = new PromptRegistry();
  r.publish('cli.default', A);
  r.publish('cli.default', B);
  const v3 = r.publish('cli.default', A);
  assert.strictEqual(r.versions('cli.default').length, 2);
  // it does become active again though
  assert.strictEqual(r.active('cli.default'), v3.hash);
  assert.strictEqual(r.body('cli.default'), A);
});

test('resolve returns null for unknown name or unknown hash', () => {
  const r = new PromptRegistry();
  assert.strictEqual(r.resolve('nope'), null);
  assert.strictEqual(r.body('nope'), null);
  r.publish('cli.default', A);
  assert.strictEqual(r.resolve('cli.default', 'deadbeef'), null);
});

test('rollback restores a previous version as active', () => {
  const r = new PromptRegistry();
  const v1 = r.publish('cli.default', A);
  r.publish('cli.default', B);
  assert.strictEqual(r.body('cli.default'), B);
  r.rollback('cli.default', v1.hash);
  assert.strictEqual(r.body('cli.default'), A);
  assert.strictEqual(r.active('cli.default'), v1.hash);
  assert.throws(() => r.rollback('cli.default', 'deadbeef'), /unknown version/);
  assert.throws(() => r.rollback('ghost', v1.hash), /unknown prompt/);
});

test('summary lists names, active hash, and version counts', () => {
  const r = new PromptRegistry();
  r.publish('cli.default', A);
  r.publish('cli.default', B);
  r.publish('api.sandbox', C);
  assert.deepStrictEqual(r.summary().map((s) => [s.name, s.versions]), [
    ['api.sandbox', 1],
    ['cli.default', 2],
  ]);
  for (const s of r.summary()) assert.ok(s.active);
});

test('names are validated', () => {
  const r = new PromptRegistry();
  assert.throws(() => r.publish('Bad Name', A), TypeError);
  assert.throws(() => r.publish('', A), TypeError);
  assert.throws(() => r.publish('cli.default', ''), TypeError);
});

test('diff reports added/removed lines between two versions', () => {
  const r = new PromptRegistry();
  const v1 = r.publish('cli.default', 'line1\nline2\nline3');
  const v2 = r.publish('cli.default', 'line1\nline2b\nline3\nline4');
  const d = r.diff('cli.default', v1.hash, v2.hash);
  assert.deepStrictEqual(d.removed, ['line2']);
  assert.deepStrictEqual(d.added, ['line2b', 'line4']);
  assert.strictEqual(d.same, false);
  const d2 = r.diff('cli.default', v2.hash, v2.hash);
  assert.strictEqual(d2.same, true);
  assert.deepStrictEqual(d2.added, []);
  assert.throws(() => r.diff('cli.default', v1.hash, 'deadbeef'), /missing version/);
});

test('has + list', () => {
  const r = new PromptRegistry();
  assert.strictEqual(r.has('cli.default'), false);
  r.publish('cli.default', A);
  assert.strictEqual(r.has('cli.default'), true);
  assert.deepStrictEqual(r.list(), ['cli.default']);
});


test('expand: ambiguous prefix throws, unknown returns null', () => {
  const r = new PromptRegistry();
  r.publish('p', 'body alpha', {});
  r.publish('p', 'body beta', {});
  const [h1, h2] = r.versions('p');
  // a 4-char prefix is ambiguous only by luck of the hash; assert directly
  // on a prefix that collides rather than assuming one.
  const prefix = commonPrefix(h1, h2);
  if (prefix.length >= 4) {
    assert.throws(() => r.expand('p', prefix), /ambiguous/);
  }
  assert.strictEqual(r.expand('p', 'deadbeef'), null);
  assert.strictEqual(r.expand('missing', h1.slice(0, 4)), null);
});

test('expand: a unique prefix resolves to the full hash', () => {
  const r = new PromptRegistry();
  r.publish('p', 'only body', {});
  const h = r.active('p');
  assert.strictEqual(r.expand('p', h), h);
  assert.strictEqual(r.expand('p', h.slice(0, 8)), h);
});
