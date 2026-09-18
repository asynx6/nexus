// Tests for compact + snapshot utilities.
// Pattern: write a temp dir, append N events, run compact, verify file + reopen.
//   node --test packages/event-system/test/snapshot.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, compact, snapshot } from '../index.js';
import { makeEvent } from '../src/events.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'nexus-compact-'));
}

function append(store, n, name = 'test.event') {
  for (let i = 0; i < n; i++) {
    store.append(makeEvent(name, { i }, 'subj-1'));
  }
}

test('compact: keeps most recent N events, drops the rest', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'events.jsonl');
    let store = new EventStore(path);
    append(store, 10);
    store.close();

    store = new EventStore(path);
    const result = compact(store, { keepRecent: 4 });
    assert.equal(result.dropped, 6);
    assert.equal(result.kept, 4);
    assert.equal(result.newSeqBase, 1);
    assert.equal(result.newPath, path);

    const reopen = new EventStore(path);
    try {
      assert.equal(reopen.count(), 4);
      const events = [...reopen.replay()];
      assert.equal(events.length, 4);
      // After compact, seq renumbers from 1. With append(seq starting at 0),
      // original events have seq 0..9. Keeping last 4 = seq 6..9 → renumbered 1..4.
      assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
      assert.deepEqual(events.map((e) => e.data.i), [6, 7, 8, 9]);
    } finally { reopen.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compact: no-op when total <= keepRecent', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'events.jsonl');
    let store = new EventStore(path);
    append(store, 3);
    store.close();

    store = new EventStore(path);
    const result = compact(store, { keepRecent: 100 });
    assert.equal(result.dropped, 0);
    assert.equal(result.kept, 3);
    assert.equal(result.newPath, null);
    const reopen = new EventStore(path);
    try { assert.equal(reopen.count(), 3); } finally { reopen.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compact: rewrites JSONL smaller when many events dropped', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'events.jsonl');
    let store = new EventStore(path);
    append(store, 1000);
    store.close();
    const beforeSize = statSync(path).size;

    store = new EventStore(path);
    compact(store, { keepRecent: 50 });
    const afterSize = statSync(path).size;
    assert.ok(afterSize < beforeSize, 'after size ' + afterSize + ' should be < before ' + beforeSize);

    const reopen = new EventStore(path);
    try {
      assert.equal(reopen.count(), 50);
      const events = [...reopen.replay()];
      assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 50 }, (_, i) => i + 1));
    } finally { reopen.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compact: optional backup path copies the original before rewrite', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'events.jsonl');
    const bakPath = join(dir, 'backup.jsonl');
    let store = new EventStore(path);
    append(store, 5);
    store.close();
    store = new EventStore(path);
    compact(store, { keepRecent: 2, backupPath: bakPath });
    assert.ok(existsSync(bakPath), 'backup file should exist');
    // backup has all 5 original events
    const lines = readFileSync(bakPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapshot: copies events to a new path, original untouched', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'events.jsonl');
    const snapPath = join(dir, 'snap.jsonl');
    let store = new EventStore(path);
    append(store, 7);
    store.close();

    store = new EventStore(path);
    const result = snapshot(store, snapPath);
    assert.equal(result.count, 7);
    assert.equal(result.path, snapPath);
    assert.ok(existsSync(snapPath));

    // original still has 7
    const reopen = new EventStore(path);
    try { assert.equal(reopen.count(), 7); } finally { reopen.close(); }
    const snapStore = new EventStore(snapPath);
    try { assert.equal(snapStore.count(), 7); } finally { snapStore.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compact: index file is regenerated and matches JSONL', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'events.jsonl');
    let store = new EventStore(path);
    append(store, 20, 'event.a');
    store.close();
    store = new EventStore(path);
    compact(store, { keepRecent: 5 });

    const reopen = new EventStore(path);
    try {
      // replay + count consistency
      const all = [...reopen.replay()];
      assert.equal(all.length, 5);
      assert.equal(reopen.count(), 5);
      // subject filter
      const subj = [...reopen.replay({ subject: 'subj-1' })];
      assert.equal(subj.length, 5);
    } finally { reopen.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
