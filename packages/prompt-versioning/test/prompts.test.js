import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptRegistry } from '../index.js';

let root;
function fresh() { root = mkdtempSync(join(tmpdir(), 'nexus-prompts-')); }
function done() { rmSync(root, { recursive: true, force: true }); }

test('publish stores content + meta and is readable', () => {
  fresh();
  const r = new PromptRegistry({ root });
  const out = r.publish('coder', '1.0.0', 'You are a coder.');
  assert.equal(out.name, 'coder');
  assert.equal(out.version, '1.0.0');
  assert.equal(r.read('coder', '1.0.0'), 'You are a coder.');
  assert.equal(r.meta('coder', '1.0.0').sha256, out.sha256);
  done();
});

test('publish refuses to overwrite an existing version (immutable)', () => {
  fresh();
  const r = new PromptRegistry({ root });
  r.publish('coder', '1.0.0', 'A');
  assert.throws(() => r.publish('coder', '1.0.0', 'B'), /already exists/);
  assert.equal(r.read('coder', '1.0.0'), 'A', 'content unchanged');
  done();
});

test('hash is stable and content-bound', () => {
  fresh();
  const r = new PromptRegistry({ root });
  const a = r.publish('p', '1', 'hello');
  const b = r.publish('q', '1', 'hello');
  assert.equal(a.sha256, b.sha256, 'same content, same hash');
  const c = r.publish('p', '2', 'hello world');
  assert.notEqual(a.sha256, c.sha256);
  done();
});

test('resolve latest follows the newest published version', () => {
  fresh();
  const r = new PromptRegistry({ root });
  r.publish('coder', '1.0.0', 'one');
  r.publish('coder', '1.1.0', 'two');
  assert.equal(r.latest('coder'), '1.1.0');
  const got = r.resolve('coder', 'latest');
  assert.equal(got.content, 'two');
  assert.equal(got.version, '1.1.0');
  done();
});

test('resolve an exact version ignores later publishes', () => {
  fresh();
  const r = new PromptRegistry({ root });
  r.publish('coder', '1.0.0', 'one');
  r.publish('coder', '2.0.0', 'two');
  assert.equal(r.resolve('coder', '1.0.0').content, 'one');
  done();
});

test('resolve returns null for unknown name or version', () => {
  fresh();
  const r = new PromptRegistry({ root });
  assert.equal(r.resolve('nope', 'latest'), null);
  r.publish('coder', '1.0.0', 'one');
  assert.equal(r.resolve('coder', '9.9.9'), null);
  done();
});

test('versions lists history newest last', () => {
  fresh();
  const r = new PromptRegistry({ root });
  r.publish('coder', '2.0.0', 'two');
  r.publish('coder', '1.0.0', 'one');
  r.publish('coder', '1.5.0', 'mid');
  assert.deepEqual(r.versions('coder').map((m) => m.version), ['1.0.0', '1.5.0', '2.0.0']);
  assert.deepEqual(r.versions('nope'), []);
  done();
});

test('rollback requires confirm and deletes only newer versions', () => {
  fresh();
  const r = new PromptRegistry({ root });
  r.publish('coder', '1.0.0', 'one');
  r.publish('coder', '1.1.0', 'two');
  r.publish('coder', '2.0.0', 'three');
  assert.throws(() => r.rollback('coder', '1.0.0'), /confirm=true/);
  const res = r.rollback('coder', '1.0.0', { confirm: true });
  assert.deepEqual(res.removed, ['1.1.0', '2.0.0']);
  assert.equal(existsSync(join(root, 'coder', '1.1.0')), false);
  assert.equal(r.latest('coder'), '1.0.0');
  done();
});

test('rollback to an unknown target version errors', () => {
  fresh();
  const r = new PromptRegistry({ root });
  r.publish('coder', '1.0.0', 'one');
  assert.throws(() => r.rollback('coder', '9', { confirm: true }), /unknown target/);
  done();
});

test('publish emits an event on the bus', () => {
  fresh();
  const r = new PromptRegistry({ root });
  const emitted = [];
  const bus = { emit: (e) => emitted.push(e) };
  r.publish('coder', '1.0.0', 'one', { bus });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, 'prompt.published');
  assert.equal(emitted[0].subject, 'coder');
  assert.equal(emitted[0].data.version, '1.0.0');
  done();
});

test('publish validates inputs', () => {
  fresh();
  const r = new PromptRegistry({ root });
  assert.throws(() => r.publish('', '1', 'x'), /name and version required/);
  assert.throws(() => r.publish('p', '', 'x'), /name and version required/);
  assert.throws(() => r.publish('p', '1', 42), /content must be a string/);
  done();
});
