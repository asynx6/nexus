// Pluggable storage backends. The manager only depends on the async contract:
//   init(), get(id), put(record), list({kind?, key?, limit?}), delete(id), close()
// Swap the backend (e.g. a vector DB) without touching the manager.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** In-memory backend — default for tests and ephemeral short-term memory. */
export class MemoryStorage {
  #map = new Map();

  async init() {}
  async close() {}

  async get(id) {
    return this.#map.get(id) ?? null;
  }

  async put(record) {
    this.#map.set(record.id, record);
    return record;
  }

  async list({ kind, key, limit } = {}) {
    let out = [...this.#map.values()];
    if (kind) out = out.filter((r) => r.kind === kind);
    if (key) out = out.filter((r) => r.key === key);
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return limit ? out.slice(0, limit) : out;
  }

  async delete(id) {
    return this.#map.delete(id);
  }
}

/** JSONL append-file backend — durable default for long-term/project memory. */
export class JsonlStorage {
  #path;
  #map = new Map();

  constructor(path) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('JsonlStorage requires a file path');
    }
    this.#path = path;
  }

  async init() {
    try {
      const text = await readFile(this.#path, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        this.#map.set(rec.id, rec);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async close() {}

  async get(id) {
    return this.#map.get(id) ?? null;
  }

  async put(record) {
    this.#map.set(record.id, record);
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, [...this.#map.values()].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return record;
  }

  async list({ kind, key, limit } = {}) {
    let out = [...this.#map.values()];
    if (kind) out = out.filter((r) => r.kind === kind);
    if (key) out = out.filter((r) => r.key === key);
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return limit ? out.slice(0, limit) : out;
  }

  async delete(id) {
    const gone = this.#map.delete(id);
    if (gone) {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(this.#path, [...this.#map.values()].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
    return gone;
  }
}
