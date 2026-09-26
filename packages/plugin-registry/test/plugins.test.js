import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlugins, loadPlugins, registerPluginTools } from '../index.js';

// A fake tool registry matching ToolRegistry's public shape.
function fakeRegistry(existing = []) {
  const tools = new Map(existing.map((n) => [n, { name: n }]));
  return {
    has: (n) => tools.has(n),
    register: (t) => {
      if (tools.has(t.name)) throw new Error('exists');
      tools.set(t.name, t);
    },
    names: () => [...tools.keys()],
  };
}

let dir;
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'nexus-plugins-'));
  // flat plugin
  writeFileSync(join(dir, 'upper.js'),
    'export const name = "upper";\nexport function tools() {\n  return [{ name: "text.upper", description: "up", handler: async () => {} }];\n}\n');
  // packaged plugin
  mkdirSync(join(dir, 'weather'));
  writeFileSync(join(dir, 'weather', 'index.js'),
    'export const name = "weather";\nexport function tools() {\n  return [{ name: "wx.now", description: "w", handler: async () => {} }];\n}\n');
  // broken plugin (no name export)
  writeFileSync(join(dir, 'broken.js'), 'export const nothing = true;\n');
  // non-js file ignored
  writeFileSync(join(dir, 'README.md'), '# nope\n');
}

test('discoverPlugins finds flat *.js and <name>/index.js, skips non-js', () => {
  setup();
  const found = discoverPlugins(dir).map((p) => p.replace(/\\/g, '/').split('/').pop());
  assert.ok(found.includes('upper.js'));
  assert.ok(found.some((f) => f === 'index.js' || f === 'broken.js'));
  assert.ok(!found.includes('README.md'));
  rmSync(dir, { recursive: true, force: true });
});

test('loadPlugins collects tools and isolates broken plugins', async () => {
  setup();
  const { plugins, errors } = await loadPlugins([dir]);
  const names = plugins.map((p) => p.name).sort();
  assert.deepEqual(names, ['upper', 'weather']);
  assert.equal(plugins.find((p) => p.name === 'upper').tools.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /name/);
  rmSync(dir, { recursive: true, force: true });
});

test('loadPlugins dedupes across directories and tolerates a missing dir', async () => {
  setup();
  const empty = mkdtempSync(join(tmpdir(), 'nexus-plugins-'));
  const res = await loadPlugins([dir, dir, empty, join(dir, 'nope')]);
  assert.equal(res.plugins.length, 2, 'same dir twice must dedupe');
  assert.equal(res.errors.length, 1);
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test('registerPluginTools registers new names and skips collisions', async () => {
  setup();
  const { plugins } = await loadPlugins([dir]);
  const reg = fakeRegistry(['text.upper']); // pre-existing collision
  const res = registerPluginTools(plugins, reg);
  assert.deepEqual(res.registered, ['wx.now']);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].tool, 'text.upper');
  assert.match(res.skipped[0].reason, /already registered/);
  rmSync(dir, { recursive: true, force: true });
});

test('registerPluginTools reports tools with no name', async () => {
  setup();
  const plugins = [{ name: 'bad', tools: [{ description: 'no name here' }] }];
  const reg = fakeRegistry();
  const res = registerPluginTools(plugins, reg);
  assert.equal(res.registered.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /missing a name/);
  rmSync(dir, { recursive: true, force: true });
});

test('a plugin whose tools() throws is isolated, not fatal', async () => {
  setup();
  writeFileSync(join(dir, 'boom.js'), 'export const name = "boom";\nexport function tools() { throw new Error("nope"); }\n');
  const { plugins, errors } = await loadPlugins([dir]);
  assert.deepEqual(plugins.map((p) => p.name).sort(), ['upper', 'weather']);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /nope/.test(e.error)));
  rmSync(dir, { recursive: true, force: true });
});
