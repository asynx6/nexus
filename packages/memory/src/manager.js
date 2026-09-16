// MemoryManager — the single funnel over a pluggable storage backend
// (mirrors the one-funnel rule in ARCHITECTURE.md: validate → store → emit).
import { makeMemory, MemoryKind, isMemoryRecord } from './types.js';

export class MemoryManager {
  #storage;
  #emit;

  /**
   * @param {{ storage: { init(), get(id), put(r), list(f), delete(id), close() },
   *           emit?: (evt: { name: string, data: Record<string, unknown> }) => void }}
   */
  constructor({ storage, emit } = {}) {
    if (!storage || typeof storage.put !== 'function') {
      throw new TypeError('MemoryManager requires a storage backend with put()');
    }
    this.#storage = storage;
    this.#emit = typeof emit === 'function' ? emit : null;
  }

  async init() {
    await this.#storage.init();
  }

  async close() {
    await this.#storage.close?.();
  }

  /** Store a record; emits memory.created through the injected emit hook. */
  async remember(kind, key, value, opts = {}) {
    const rec = makeMemory(kind, key, value, opts);
    await this.#storage.put(rec);
    this.#emit?.({ name: 'memory.created', data: { id: rec.id, kind: rec.kind, key: rec.key, subject: rec.subject } });
    return rec;
  }

  /** Convenience wrappers for the three plan kinds. */
  rememberShort(key, value, opts = {}) { return this.remember(MemoryKind.SHORT, key, value, opts); }
  rememberLong(key, value, opts = {}) { return this.remember(MemoryKind.LONG, key, value, opts); }
  rememberProject(key, value, opts = {}) { return this.remember(MemoryKind.PROJECT, key, value, opts); }

  async get(id) {
    return this.#storage.get(id);
  }

  /** Latest-first list, optionally filtered by kind and/or exact key. */
  async recall({ kind, key, limit } = {}) {
    if (kind && !Object.values(MemoryKind).includes(kind)) {
      throw new TypeError(`invalid memory kind "${kind}"`);
    }
    return this.#storage.list({ kind, key, limit });
  }

  /** Latest record for a key, or null. */
  async recallOne(kind, key) {
    const [rec] = await this.recall({ kind, key, limit: 1 });
    return rec ?? null;
  }

  /** Re-save an existing record (useful for updating value in place by id). */
  async update(id, value) {
    const rec = await this.#storage.get(id);
    if (!rec || !isMemoryRecord(rec)) return null;
    const next = { ...rec, value, ts: new Date().toISOString() };
    await this.#storage.put(next);
    return next;
  }

  async forget(id) {
    return this.#storage.delete(id);
  }
}
