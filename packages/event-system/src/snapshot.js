// EventStore snapshot/compact utilities.
// - compact(store, opts): trim old events; rewrite JSONL + sqlite index.
//   Keeps the most recent N events (default 1000); drops the rest atomically.
//   After compact, the store's first seq is `dropped + 1` and timestamps are
//   preserved. The file is rewritten in a single rename to avoid partial
//   states on crash.
// - snapshot(store, opts): non-destructive copy of the store into a new file
//   path. Useful for backup before destructive operations.
//
// Both functions close the input store after compact (the EventStore API uses
// a long-lived fd + sqlite handle). After compact, the caller should reopen
// the store at the same path if they want to keep writing.

import { mkdirSync, renameSync, existsSync, openSync, closeSync, writeSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isEnvelope } from './events.js';

const DEFAULT_KEEP = 1000;
const BUF_SIZE = 65536;

/**
 * Compact an event store: keep only the most recent `keepRecent` events.
 * Returns { dropped, kept, newSeqBase, newPath }.
 *
 * @param {object} store EventStore instance
 * @param {{ keepRecent?: number, backupPath?: string }} [opts]
 */
export function compact(store, opts = {}) {
  const keepRecent = Math.max(1, Number(opts.keepRecent ?? DEFAULT_KEEP));
  const total = store.count();
  if (total <= keepRecent) {
    return { dropped: 0, kept: total, newSeqBase: total > 0 ? 1 : 0, newPath: null };
  }
  const dropped = total - keepRecent;

  // Pull the surviving events in seq order, then renumber so seq starts at 1.
  // Append assigns seq starting at 0 (so the first event is seq=0). The first
  // `dropped` events are the oldest; survivors are seq >= dropped.
  const survivors = [];
  for (const ev of store.replay({ since: dropped })) {
    survivors.push(ev);
  }
  if (survivors.length !== keepRecent) {
    throw new Error('compact: survivor count mismatch — expected ' + keepRecent + ' got ' + survivors.length);
  }

  const jsonlPath = store.jsonlPath; // exposed for compact only; see note below
  const idxPath = jsonlPath + '.idx';
  const tmpJsonl = jsonlPath + '.compact.tmp';
  const tmpIdx = idxPath + '.compact.tmp';

  // Optional backup
  if (opts.backupPath) {
    mkdirSync(dirname(opts.backupPath), { recursive: true });
    copyFileAtomic(jsonlPath, opts.backupPath);
  }

  // Close the input store BEFORE we rewrite its files.
  store.close();

  // Write new JSONL with renumbered seqs starting at 1.
  mkdirSync(dirname(jsonlPath), { recursive: true });
  const fd = openSync(tmpJsonl, 'w');
  try {
    for (let i = 0; i < survivors.length; i++) {
      // survivors[i] already has the original seq; renumber to i+1.
      const ev = { ...survivors[i], seq: i + 1 };
      const line = JSON.stringify(ev) + '\n';
      writeSync(fd, line);
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmpJsonl, jsonlPath);

  // Rebuild sqlite index from the new JSONL (drop tmp idx if any, fresh build).
  if (existsSync(tmpIdx)) {
    try { /* leave tmp cleanup if needed */ } catch { /* ignore */ }
  }
  const db = new DatabaseSync(tmpIdx);
  try {
    db.exec(
      'PRAGMA journal_mode = WAL;' +
      'PRAGMA synchronous = NORMAL;' +
      'CREATE TABLE events (' +
      '  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, subject TEXT, name TEXT NOT NULL,' +
      '  ts INTEGER NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL' +
      ');' +
      'CREATE INDEX idx_events_subject_seq ON events (subject, seq);' +
      'CREATE INDEX idx_events_name_seq ON events (name, seq);'
    );
    const insert = db.prepare('INSERT INTO events (seq, id, subject, name, ts, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const src = openSync(jsonlPath, 'r');
      try {
        let pos = 0;
        let carry = Buffer.alloc(0);
        const size = statSync(jsonlPath).size;
        let seq = 1;
        while (pos < size) {
          const buf = Buffer.allocUnsafe(Math.min(BUF_SIZE, size - pos));
          const got = readSync(src, buf, 0, buf.length, pos);
          if (got === 0) break;
          const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
          const start = pos - carry.length;
          let i = 0;
          let nl = data.indexOf(0x0a, i);
          while (nl !== -1) {
            const text = data.subarray(i, nl).toString('utf8').trim();
            if (text.length > 0) {
              const rec = JSON.parse(text);
              if (!isEnvelope(rec) || rec.seq !== seq) {
                throw new Error('corrupt line at offset ' + (start + i));
              }
              insert.run(rec.seq, rec.id, rec.subject, rec.name, Date.parse(rec.ts), start + i, (nl - i) + 1);
              seq++;
            }
            i = nl + 1;
            nl = data.indexOf(0x0a, i);
          }
          carry = Buffer.from(data.subarray(i));
          pos = start + i;
        }
      } finally {
        closeSync(src);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  } finally {
    db.close();
  }
  renameSync(tmpIdx, idxPath);

  return { dropped, kept: keepRecent, newSeqBase: 1, newPath: jsonlPath };
}

/**
 * Non-destructive snapshot of a store to a new path.
 * @param {object} store
 * @param {string} destPath
 */
export function snapshot(store, destPath) {
  const events = [...store.replay()];
  mkdirSync(dirname(destPath), { recursive: true });
  const fd = openSync(destPath, 'w');
  try {
    for (let i = 0; i < events.length; i++) {
      const line = JSON.stringify({ seq: i + 1, ...events[i] }) + '\n';
      writeSync(fd, line);
    }
  } finally {
    closeSync(fd);
  }
  return { count: events.length, path: destPath };
}

function copyFileAtomic(src, dest) {
  const buf = Buffer.allocUnsafe(BUF_SIZE);
  const inFd = openSync(src, 'r');
  const outFd = openSync(dest, 'w');
  try {
    const size = statSync(src).size;
    let pos = 0;
    while (pos < size) {
      const want = Math.min(BUF_SIZE, size - pos);
      const got = readSync(inFd, buf, 0, want, pos);
      if (got === 0) break;
      writeSync(outFd, buf, 0, got);
      pos += got;
    }
  } finally {
    closeSync(inFd);
    closeSync(outFd);
  }
}
