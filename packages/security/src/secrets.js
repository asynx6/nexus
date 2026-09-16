// Secret isolation (plan sec 6 "secret isolation", sec 22 "jangan pernah
// menyimpan secret dalam repository"). Secrets live in memory only and are
// materialized into env for a single exec; nothing ever hits disk here.
import { chmodSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class SecretStore {
  #map = new Map();

  set(name, value) {
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new TypeError(`secret name must be UPPER_SNAKE (got "${name}")`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('secret value must be a non-empty string');
    }
    this.#map.set(name, value);
  }

  has(name) { return this.#map.has(name); }

  /** Direct read is deliberately NOT exposed; only inject()/withTempFile() consume values. */
  names() { return [...this.#map.keys()]; }

  delete(name) { return this.#map.delete(name); }

  /**
   * Merge selected secrets into a base env for one execution.
   * @param {string[]} names
   * @param {Record<string,string>} [base]
   */
  inject(names, base = {}) {
    const env = { ...base };
    for (const n of names) {
      if (!this.#map.has(n)) throw new Error(`unknown secret "${n}"`);
      env[n] = this.#map.get(n);
    }
    return env;
  }

  /**
   * For workloads that need a file, not an env var: write to a private tmp
   * dir (0600), hand the path to fn, erase + unlink right after, whatever happens.
   * @param {string} name
   * @param {(path: string) => Promise<void> | void} fn
   */
  async withTempFile(name, fn) {
    if (!this.#map.has(name)) throw new Error(`unknown secret "${name}"`);
    const dir = join(tmpdir(), `nexus-secrets-${randomBytes(6).toString('hex')}`);
    const path = join(dir, name.toLowerCase());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, this.#map.get(name), { mode: 0o600 });
      await fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
