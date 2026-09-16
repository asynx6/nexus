// @nexus/memory — long-term agent memory built on EventStore.
// Indexes events into sqlite (subject, name, ts) for fast filtered recall.
// Zero external deps (Node ≥22, node:sqlite).

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Memory = thin sqlite index on top of EventStore.
 *  Use it when you need fast filtered recall of past events (subject + name + ts range).
 *  For raw event-by-event replay, use EventStore directly.
 */
export class Memory {
  #store;
  #db;
  #insert;
  #inTxn = false;

  /** @param {{ store: EventStore, dbPath: string }} opts
   *  dbPath must be supplied (we don't poke into EventStore's private fields). */
  constructor({ store, dbPath }) {
    if (!store) throw new TypeError('store required');
    if (!dbPath) throw new TypeError('dbPath required (sqlite index path)');
    this.#store = store;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(
      'PRAGMA journal_mode = WAL;' +
      'CREATE TABLE IF NOT EXISTS memory (' +
      '  id TEXT NOT NULL UNIQUE,' +
      '  subject TEXT,' +
      '  name TEXT NOT NULL,' +
      '  ts INTEGER NOT NULL' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_memory_subject_ts ON memory (subject, ts);' +
      'CREATE INDEX IF NOT EXISTS idx_memory_name_ts ON memory (name, ts);'
    );
    this.#insert = this.#db.prepare(
      'INSERT OR IGNORE INTO memory (id, subject, name, ts) VALUES (?, ?, ?, ?)'
    );
  }

  /** Index one envelope. Returns true if newly inserted, false if already known. */
  index(env) {
    if (!env || typeof env.id !== 'string' || typeof env.name !== 'string') return false;
    const ts = typeof env.ts === 'number' ? env.ts : Date.parse(env.ts ?? '') ?? 0;
    const r = this.#insert.run(env.id, env.subject ?? null, env.name, ts);
    return r.changes > 0;
  }

  /** Index a batch inside a single transaction. Returns count of new rows. */
  indexBatch(envs) {
    this.#db.exec('BEGIN');
    this.#inTxn = true;
    let n = 0;
    try {
      for (const e of envs) if (this.index(e)) n++;
      this.#db.exec('COMMIT');
      this.#inTxn = false;
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      this.#inTxn = false;
      throw err;
    }
    return n;
  }

  /** Bulk-index everything from the underlying EventStore. Idempotent (UNIQUE on id). */
  async rebuild() {
    let n = 0;
    const batch = [];
    for await (const env of this.#store.replay({})) {
      batch.push(env);
      if (batch.length >= 256) { n += this.indexBatch(batch); batch.length = 0; }
    }
    if (batch.length) n += this.indexBatch(batch);
    return n;
  }

  /** Recall indexed rows (newest first). Returns {id, subject, name, ts}.
   *  Hydrate the full envelope via EventStore.replay if needed. */
  recall({ subject, name, sinceTs, untilTs, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (subject !== undefined) { where.push('subject = ?'); args.push(subject); }
    if (name !== undefined)    { where.push('name = ?');    args.push(name); }
    if (Number.isFinite(sinceTs))  { where.push('ts >= ?'); args.push(sinceTs); }
    if (Number.isFinite(untilTs))  { where.push('ts <= ?'); args.push(untilTs); }
    const sql = 'SELECT id, subject, name, ts FROM memory' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY ts DESC LIMIT ?';
    args.push(limit);
    return this.#db.prepare(sql).all(...args);
  }

  /** Recall + hydrate full envelopes from EventStore in chronological order.
   *  Convenience for prompt injection (always returns oldest-first). */
  async *recallHydrated(opts = {}) {
    const rows = this.recall(opts);
    if (!rows.length) return;
    const byId = new Map();
    for await (const env of this.#store.replay({})) byId.set(env.id, env);
    for (const r of rows) {
      const env = byId.get(r.id);
      if (env) yield env;
    }
  }

  /** Count indexed rows. */
  count({ subject, name } = {}) {
    const where = [];
    const args = [];
    if (subject !== undefined) { where.push('subject = ?'); args.push(subject); }
    if (name !== undefined)    { where.push('name = ?');    args.push(name); }
    const sql = 'SELECT COUNT(*) AS n FROM memory' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    return this.#db.prepare(sql).get(...args).n;
  }

  close() {
    if (this.#inTxn) { try { this.#db.exec('ROLLBACK'); } catch {} }
    try { this.#db.close(); } catch {}
  }
}

/** Convenience: build a Memory backed by an EventStore at <dir>/events.jsonl,
 *  with the index file at <dir>/memory.idx. */
export function openMemory(store, dir) {
  return new Memory({ store, dbPath: join(dir, 'memory.idx') });
}
