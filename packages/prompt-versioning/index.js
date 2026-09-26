// @nexus/prompt-versioning — versioned system prompts with audit trail.
//
// A prompt is stored once per version under .nexus/prompts/<name>/<version>.md
// plus an index entry recording the sha256 of the content. Version strings are
// caller-supplied (semver or date or "latest") and must be unique per prompt;
// `publish` refuses to overwrite an existing version — prompts are immutable,
// so a run that cites a version reproduces the same system prompt every time.
//
// `resolve(name, ref)` follows `latest` to whatever was published last, or
// returns the exact version asked for. Every change is an event on the bus.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_ROOT = '.nexus/prompts';

export class PromptRegistry {
  /** @param {{ root?: string }} [opts] root defaults to .nexus/prompts */
  constructor({ root = DEFAULT_ROOT } = {}) {
    this.root = root;
  }

  _dir(name, version) { return join(this.root, name, version); }

  /** sha256 hex of the content. */
  static hash(content) { return createHash('sha256').update(content, 'utf8').digest('hex'); }

  /**
   * Store a prompt version. Refuses to overwrite an existing version.
   * @returns {{ name: string, version: string, sha256: string }}
   */
  publish(name, version, content, { bus = null, meta = {} } = {}) {
    if (!name || !version) throw new Error('publish: name and version required');
    if (typeof content !== 'string') throw new Error('publish: content must be a string');
    const dir = this._dir(name, version);
    const file = join(dir, 'prompt.md');
    if (existsSync(file)) throw new Error(`publish: ${name}@${version} already exists — prompts are immutable`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, 'utf8');
    const sha = PromptRegistry.hash(content);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name, version, sha256: sha, ts: new Date().toISOString(), ...meta }, null, 2) + '\n');
    if (bus) bus.emit({ id: meta.id, ts: new Date().toISOString(), name: 'prompt.published', subject: name, data: { version, sha256: sha } });
    return { name, version, sha256: sha };
  }

  /** Read one version's content. */
  read(name, version) {
    const file = join(this._dir(name, version), 'prompt.md');
    if (!existsSync(file)) throw new Error(`no such prompt: ${name}@${version}`);
    return readFileSync(file, 'utf8');
  }

  /** Meta for one version, or null. */
  meta(name, version) {
    const file = join(this._dir(name, version), 'meta.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  /** Resolve `latest` to the newest published version of `name`. */
  latest(name) {
    const dir = join(this.root, name);
    if (!existsSync(dir)) return null;
    const versions = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return versions.length ? versions[versions.length - 1] : null;
  }

  /**
   * Resolve a ref: `latest` → newest version, otherwise the exact version.
   * @returns {{ name: string, version: string, content: string, sha256: string } | null}
   */
  resolve(name, ref) {
    const version = ref === 'latest' ? this.latest(name) : ref;
    if (!version) return null;
    const dir = this._dir(name, version);
    if (!existsSync(dir)) return null;
    const content = this.read(name, version);
    const meta = this.meta(name, version);
    return { name, version, content, sha256: meta ? meta.sha256 : PromptRegistry.hash(content) };
  }

  /** All versions of a prompt, newest last. */
  versions(name) {
    const dir = join(this.root, name);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .map((version) => this.meta(name, version))
      .filter(Boolean);
  }

  /**
   * Roll the `latest` pointer back to an earlier version by deleting newer ones.
   * Dangerous by design — it rewrites history — so it is a separate method and
   * requires an explicit confirm. Returns what was removed.
   */
  rollback(name, targetVersion, { confirm = false } = {}) {
    if (!confirm) throw new Error('rollback: pass confirm=true (it deletes newer versions)');
    const versions = this.versions(name).map((m) => m.version);
    const idx = versions.indexOf(targetVersion);
    if (idx < 0) throw new Error(`rollback: unknown target ${name}@${targetVersion}`);
    const removed = [];
    for (const v of versions.slice(idx + 1)) {
      rmSync(this._dir(name, v), { recursive: true, force: true });
      removed.push(v);
    }
    return { name, now: targetVersion, removed };
  }
}
