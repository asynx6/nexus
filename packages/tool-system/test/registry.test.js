// Unit tests: registry + schema validator (no Docker).
import { test } from 'node:test';
import assert from 'node:assert';
import { ToolRegistry, validateArgs } from '../index.js';

const okTool = { name: 'fs.read', description: 'd', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, handler: async () => ({}) };

test('register/list/specs', () => {
  const r = new ToolRegistry().register(okTool);
  assert.strictEqual(r.list().length, 1);
  assert.strictEqual(r.has('fs.read'), true);
  const spec = r.specs()[0];
  assert.strictEqual(spec.function.name, 'fs.read');
  assert.strictEqual(spec.type, 'function');
});

test('bad definitions rejected at boot', () => {
  assert.throws(() => new ToolRegistry().register({ ...okTool, name: 'Fs Read' }), /dot.separated_kind/);
  assert.throws(() => new ToolRegistry().register({ ...okTool, handler: 1 }), /handler/);
  assert.throws(() => new ToolRegistry().register({ ...okTool, schema: {} }), /schema/);
  assert.throws(() => new ToolRegistry().register(okTool).register(okTool), /already registered/);
});

test('validateArgs: types, required, nested, additionalProperties', () => {
  assert.deepStrictEqual(validateArgs({ path: '/a' }, okTool.schema), []);
  assert.deepStrictEqual(validateArgs({}, okTool.schema), ['args.path: required']);
  assert.deepStrictEqual(validateArgs({ path: 5 }, okTool.schema), ['args.path: expected string']);
  const s = { type: 'object', properties: { n: { type: 'integer', enum: [1, 2] }, list: { type: 'array', items: { type: 'string' } }, extra: { type: 'boolean' } }, additionalProperties: false };
  assert.deepStrictEqual(validateArgs({ n: 1.5 }, s), ['args.n: expected integer']);
  assert.deepStrictEqual(validateArgs({ n: 3 }, s), ['args.n: must be one of 1, 2']);
  assert.deepStrictEqual(validateArgs({ list: ['a', 2] }, s), ['args.list[1]: expected string']);
  assert.deepStrictEqual(validateArgs({ nope: 1 }, s), ['args.nope: unknown property']);
});
