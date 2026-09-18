// @nexus/cli graceful shutdown unit tests. Same shape as the api tests but
// driven by an explicit onClose callback (the cli owns its lifecycle; the api
// owns the http/taskStore/eventStore triplet).

import { test } from 'node:test';
import assert from 'node:assert';
import { installGracefulShutdown } from '../src/graceful.js';

function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (msg, meta) => lines.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => lines.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => lines.push({ level: 'error', msg, meta }),
    debug: () => {},
  };
}

test('throws when onClose missing', () => {
  assert.throws(() => installGracefulShutdown({}), /onClose required/);
});

test('close() runs onClose, then exits 0', async () => {
  let called = 0;
  const exitCalls = [];
  const handle = installGracefulShutdown({
    onClose: async () => { called += 1; },
    logger: makeLogger(),
    exit: (code) => { exitCalls.push(code); },
  });
  await handle.close();
  assert.strictEqual(called, 1);
  assert.deepStrictEqual(exitCalls, [0]);
});

test('onClose throwing -> exit(1)', async () => {
  const exitCalls = [];
  const logger = makeLogger();
  await installGracefulShutdown({
    onClose: async () => { throw new Error('boom'); },
    logger,
    exit: (code) => { exitCalls.push(code); },
  }).close();
  assert.deepStrictEqual(exitCalls, [1]);
  assert.ok(logger.lines.some((l) => l.level === 'error' && /onClose threw/.test(l.msg)));
});

test('re-entrant: second close() escalates to exit(1)', async () => {
  const exitCalls = [];
  let resolveClose;
  const handle = installGracefulShutdown({
    onClose: () => new Promise((r) => { resolveClose = r; }),
    logger: makeLogger(),
    exit: (code) => { exitCalls.push(code); },
  });
  const first = handle.close();
  await new Promise((r) => setImmediate(r));
  await handle.close(); // escalation
  assert.deepStrictEqual(exitCalls, [1]);
  resolveClose();
  await first;
});

test('multiple escalations only exit(1) once', async () => {
  const exitCalls = [];
  let resolveClose;
  const handle = installGracefulShutdown({
    onClose: () => new Promise((r) => { resolveClose = r; }),
    logger: makeLogger(),
    exit: (code) => { exitCalls.push(code); },
  });
  const first = handle.close();
  await new Promise((r) => setImmediate(r));
  await handle.close();
  await handle.close();
  assert.deepStrictEqual(exitCalls, [1]);
  resolveClose();
  await first;
});

test('uninstall() detaches SIGTERM/SIGINT', async () => {
  const exitCalls = [];
  const handle = installGracefulShutdown({
    onClose: async () => {},
    logger: makeLogger(),
    exit: (code) => { exitCalls.push(code); },
  });
  handle.uninstall();
  process.emit('SIGTERM');
  process.emit('SIGINT');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(exitCalls, []);
  await handle.close();
  assert.deepStrictEqual(exitCalls, [0]);
});

test('isActive=false short-circuits close (no exit, no onClose)', async () => {
  let called = 0;
  const exitCalls = [];
  await installGracefulShutdown({
    onClose: async () => { called += 1; },
    logger: makeLogger(),
    isActive: () => false,
    exit: (code) => { exitCalls.push(code); },
  }).close();
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(exitCalls, []);
});

test('SIGINT triggers shutdown via installed handler', async () => {
  const exitCalls = [];
  let called = 0;
  const handle = installGracefulShutdown({
    onClose: async () => { called += 1; },
    logger: makeLogger(),
    exit: (code) => { exitCalls.push(code); },
  });
  process.emit('SIGINT');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(called, 1);
  assert.deepStrictEqual(exitCalls, [0]);
  handle.uninstall();
});
