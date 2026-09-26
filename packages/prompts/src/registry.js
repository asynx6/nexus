// Named prompt registry with content-addressed versioning (A4).
//
// A prompt is identified by a stable NAME (e.g. 'cli.default'); each edit of
// its body is a new VERSION, addressed by the sha256 of the body. The active
// version is the one a run uses; historical versions stay readable so an old
// run can be replayed byte-for-byte and a diff attributed to a prompt change
// can be proven.
//
// Versioning rule: publishing a body whose hash already exists under the name
// is a no-op (re-publishing the same bytes is idempotent). Publishing a NEW
// body creates a new version and bumps the name's `latest`. `pin(name)` and
// `resolve(ref)` are how a run fixes the exact bytes it will use.
//
import { sha256Hex } from './hash.js';

// ponytail: versions live in memory; a process restart loses history. Persist
// <name>.json files under a prompts dir when a server needs recall — the
// { name, versions, active } shape is already JSON.

export class PromptRegistry {
  #prompts = new Map();

  /** Register a name, or publish a new version of an existing one. */
  publish(name, body, { note = null } = {}) {
    assertName(name);
    if (typeof body !== 'string' || body.length === 0) throw new TypeError('body must be a non-empty string');
    let p = this.#prompts.get(name);
    if (!p) {
      p = { name, versions: new Map(), active: null };
      this.#prompts.set(name, p);
    }
    const hash = sha256Hex(body);
    if (!p.versions.has(hash)) {
      p.versions.set(hash, { hash, body, note, publishedAt: new Date().toISOString() });
      p.active = hash;
    } else if (p.active !== hash) {
      // same bytes re-published: make it the active version again
      p.active = hash;
    }
    return this.version(name, hash);
  }

  /** All known version hashes for a name, oldest first. */
  versions(name) {
    const p = this.#prompts.get(name);
    return p ? [...p.versions.keys()] : [];
  }

  /** The currently active version hash for a name (null when unknown). */
  active(name) {
    const p = this.#prompts.get(name);
    return p ? p.active : null;
  }

  /** Resolve a ref — exact hash, or 'latest'/null for the active version. */
  resolve(name, ref = null) {
    const p = this.#prompts.get(name);
    if (!p) return null;
    const hash = ref === null || ref === 'latest' ? p.active : this.expand(name, ref);
    if (hash === null) return null;
    return this.version(name, hash);
  }

  /** Full version record (body included). Null when name+ref are unknown. */
  version(name, hash) {
    const p = this.#prompts.get(name);
    if (!p) return null;
    const v = p.versions.get(hash);
    return v ? { name, ...v } : null;
  }

  /** Body only — the hot path for the agent loop. */
  body(name, ref = null) {
    const v = this.resolve(name, ref);
    return v ? v.body : null;
  }

  has(name) { return this.#prompts.has(name); }

  /**
   * Accept a full 64-char hash, or a unique prefix of it (>=4 chars) as printed
   * by `nexus prompts list`. Ambiguous prefixes throw; unknown ones return null.
   * @param {string} name
   * @param {string} ref
   * @returns {string|null} the full hash, or null when it does not resolve
   */
  expand(name, ref) {
    const p = this.#prompts.get(name);
    if (!p) return null;
    if (p.versions.has(ref)) return ref;
    if (typeof ref === 'string' && ref.length >= 4) {
      const matches = [...p.versions.keys()].filter((h) => h.startsWith(ref));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error(`ambiguous version prefix "${ref}" for "${name}" (${matches.length} matches)`);
    }
    return null;
  }

  list() { return [...this.#prompts.keys()].sort(); }

  /** Roll the active version back to a previously published hash. */
  rollback(name, hash) {
    const p = this.#prompts.get(name);
    if (!p) throw new Error(`unknown prompt "${name}"`);
    const full = p.versions.has(hash) ? hash : this.expand(name, hash);
    if (!full) throw new Error(`unknown version ${hash} for "${name}"`);
    hash = full;
    p.active = hash;
    return this.version(name, hash);
  }

  /** Names + active hashes + version counts, for `nexus prompts list`. */
  summary() {
    return this.list().map((name) => {
      const p = this.#prompts.get(name);
      return { name, active: p.active, versions: p.versions.size };
    });
  }

  /**
   * Diff two versions of one name, line based.
   * @returns {{ added: string[], removed: string[], same: boolean }}
   */
  diff(name, leftRef, rightRef) {
    const left = this.resolve(name, leftRef);
    const right = this.resolve(name, rightRef);
    if (!left || !right) throw new Error(`cannot diff: missing version under "${name}"`);
    const a = left.body.split('\n');
    const b = right.body.split('\n');
    const removed = a.filter((l) => !b.includes(l));
    const added = b.filter((l) => !a.includes(l));
    return { added, removed, same: left.hash === right.hash };
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new TypeError(`invalid prompt name "${name}" (lowercase, . _ - only)`);
  }
}

