import { test } from 'node:test';
import assert from 'node:assert';
import { NAME, ToolRegistry, ToolExecutor, fsTools, terminalTools } from '../index.js';

test('tool-system facade exports', () => {
  assert.strictEqual(NAME, '@nexus/tool-system');
  assert.strictEqual(typeof ToolRegistry, 'function');
  assert.strictEqual(typeof ToolExecutor, 'function');
  assert.strictEqual(fsTools().length, 5);
  assert.strictEqual(terminalTools().length, 1);
});

test('built-in tools pass their own definition rules', () => {
  const r = new ToolRegistry();
  for (const t of [...fsTools(), ...terminalTools()]) r.register(t);
  assert.deepStrictEqual(r.list().map((t) => t.name), ['fs.read', 'fs.write', 'fs.edit', 'fs.download', 'fs.upload', 'terminal.exec']);
});
