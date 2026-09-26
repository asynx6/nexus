import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isTelemetryEnabled, setTelemetryEnabled,
  Telemetry, writeTelemetryBatch, TELEMETRY_FLAG_FILE
} from '../index.js';

let dir;
function fresh() { dir = mkdtempSync(join(tmpdir(), 'nexus-telem-')); }

test('telemetry is OFF by default', () => {
  fresh();
  assert.equal(isTelemetryEnabled({ env: {}, cwd: dir }), false);
  rmSync(dir, { recursive: true, force: true });
});

test('NEXUS_TELEMETRY=1 enables, =0 is a hard off that beats the flag file', () => {
  fresh();
  assert.equal(isTelemetryEnabled({ env: { NEXUS_TELEMETRY: '1' }, cwd: dir }), true);
  setTelemetryEnabled(true, { cwd: dir });
  assert.equal(existsSync(join(dir, TELEMETRY_FLAG_FILE)), true);
  assert.equal(isTelemetryEnabled({ env: { NEXUS_TELEMETRY: '0' }, cwd: dir }), false,
    'explicit 0 must win even with the flag file present');
  rmSync(dir, { recursive: true, force: true });
});

test('setTelemetryEnabled writes and then clears the flag', () => {
  fresh();
  setTelemetryEnabled(true, { cwd: dir });
  assert.equal(isTelemetryEnabled({ env: {}, cwd: dir }), true);
  setTelemetryEnabled(false, { cwd: dir });
  assert.equal(isTelemetryEnabled({ env: {}, cwd: dir }), false, 'flag file now says disabled');
  rmSync(dir, { recursive: true, force: true });
});

test('disabled Telemetry records nothing and flush returns null', () => {
  const t = new Telemetry({ enabled: false });
  t.record('tool.call', 'fs.read');
  const stop = t.start('tool.duration', 'fs.read');
  stop();
  assert.equal(t.flush(), null);
});

test('enabled Telemetry counts and times, then flush clears the buffer', () => {
  let now = 1000;
  const t = new Telemetry({ enabled: true, clock: () => now });
  t.record('tool.call', 'fs.read');
  t.record('tool.call', 'fs.read');
  t.record('tool.call', 'terminal.exec');
  const stop = t.start('tool.duration', 'fs.read');
  now += 500;
  stop();
  const b = t.flush();
  assert.equal(b.version, 1);
  assert.deepEqual(b.counters, { 'tool.call.fs.read': 2, 'tool.call.terminal.exec': 1 });
  assert.equal(b.timers['tool.duration.fs.read'].n, 1);
  assert.equal(b.timers['tool.duration.fs.read'].totalMs, 500);
  // buffer cleared
  assert.equal(t.flush(), null);
});

test('labels default to "total"', () => {
  const t = new Telemetry({ enabled: true });
  t.record('run.complete');
  assert.deepEqual(t.flush().counters, { 'run.complete.total': 1 });
});

test('record/flush never throws on unstringifiable keys', () => {
  const t = new Telemetry({ enabled: true });
  // A circular object as a label key: must not propagate an exception.
  const bad = {};
  bad.self = bad;
  t.record('x', bad);
  const out = t.flush();
  // Whatever landed in the batch, the call must have survived.
  assert.ok(out === null || typeof out === 'object');
});

test('writeTelemetryBatch appends one JSON line per flush', () => {
  fresh();
  const p = join(dir, 'telem.jsonl');
  writeTelemetryBatch({ version: 1, counters: { 'a.b': 1 } }, p);
  writeTelemetryBatch({ version: 1, counters: { 'a.b': 2 } }, p);
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).counters['a.b'], 2);
  rmSync(dir, { recursive: true, force: true });
});

test('writeTelemetryBatch ignores a null batch or missing path', () => {
  fresh();
  assert.equal(writeTelemetryBatch(null, join(dir, 'x.jsonl')), false);
  assert.equal(writeTelemetryBatch({ a: 1 }, ''), false);
  assert.equal(existsSync(join(dir, 'x.jsonl')), false);
  rmSync(dir, { recursive: true, force: true });
});
