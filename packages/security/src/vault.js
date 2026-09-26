// E1 per-project encrypted secrets — a Vault on top of SecretStore.
//
// Threat model: .nexus/secrets.enc is a file an attacker/backup/CI-artifact
// reader can reach. Values must not be recoverable from it without the
// project key. Plaintext is still memory-only at runtime (SecretStore
// contract from P04); the vault just adds an at-rest layer.
//
// Key derivation: scrypt(passphrase, per-project salt) -> 32-byte AES key.
//   - scrypt costs (N=2^16, r=8, p=1) are tuned for a one-shot CLI load, not
//     per-request. Profile before raising; laptop-class ~120ms.
//   - The salt is random per project, stored in the header, so two projects
//     sharing a passphrase still get different keys.
//
// AEAD: aes-256-gcm. Random 12-byte IV per entry, auth tag appended. GCM
// gives us confidentiality + tamper detection in one primitive; a corrupted
// or swapped ciphertext fails open at decrypt, never silently.
//
// Envelope per entry: { iv, ct } base64. The file holds a versioned header
// so the format can evolve without guessing.
//
// ponytail: passphrase comes from NEXUS_PROJECT_PASSPHRASE (env or stdin
// prompt) — no keyfile management yet. When multi-tenant lands, swap the
// derivation input for a KMS-wrapped key; the {version, salt, entries}
// shape stays.

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const VERSION = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
// VPS-class boxes (1 vCPU, <1GB RAM) OOM on the default 32MB scrypt window at
// N=2^16, and OpenSSL rejects the op before it OOMs; maxmem must cover
// N*128*r*p (~67MB). Tests lower N via NEXUS_SCRYPT_N to keep suites fast.
const SCRYPT_OPTS = {
  N: Number(process.env.NEXUS_SCRYPT_N) || 2 ** 16,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
};

export class Vault {
  #key = null;
  #salt = null;
  #entries = new Map();

  /** Derive the project key from a passphrase + salt. Idempotent. */
  unlock(passphrase, salt) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new TypeError('passphrase required');
    }
    if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new TypeError('salt must be a 16-byte Buffer');
    this.#key = scryptSync(passphrase, salt, KEY_LEN, SCRYPT_OPTS);
    this.#salt = salt;
    this.#entries.clear();
  }

  get locked() { return this.#key === null; }

  /** Project salt (public; it defeats rainbow tables, not brute force). */
  get salt() { return this.#salt; }

  #requireKey() {
    if (this.#key === null) throw new Error('vault is locked — call unlock() first');
  }

  encryptValue(plaintext) {
    this.#requireKey();
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new TypeError('plaintext must be a non-empty string');
    }
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      ct: Buffer.concat([ct, tag]).toString('base64'),
    };
  }

  decryptValue(entry) {
    this.#requireKey();
    if (!entry || typeof entry.iv !== 'string' || typeof entry.ct !== 'string') {
      throw new TypeError('invalid envelope { iv, ct }');
    }
    const iv = Buffer.from(entry.iv, 'base64');
    const buf = Buffer.from(entry.ct, 'base64');
    if (iv.length !== IV_LEN) throw new Error('bad iv length');
    if (buf.length < 16) throw new Error('ciphertext too short (missing auth tag)');
    const ct = buf.subarray(0, -16);
    const tag = buf.subarray(-16);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key or tampered ciphertext — never fall through to partial data.
      throw new Error('decrypt failed: wrong passphrase or corrupted entry');
    }
  }

  /** Encrypt and store one secret under an UPPER_SNAKE name. */
  set(name, plaintext) {
    assertEnvName(name);
    this.#requireKey();
    this.#entries.set(name, this.encryptValue(plaintext));
    return this;
  }

  /** Decrypt one entry. Returns null when absent (no probing oracle). */
  get(name) {
    assertEnvName(name);
    const entry = this.#entries.get(name);
    if (!entry) return null;
    return this.decryptValue(entry);
  }

  has(name) { return this.#entries.has(name); }

  names() { return [...this.#entries.keys()].sort(); }

  delete(name) { return this.#entries.delete(name); }

  clear() { this.#entries.clear(); }

  /** Serialize header + entries. Uses the salt from unlock()/create(). */
  serialize() {
    if (this.#salt === null) throw new Error('vault has no salt — unlock() first');
    const entries = {};
    for (const [name, entry] of [...this.#entries.entries()].sort()) entries[name] = entry;
    return JSON.stringify({ version: VERSION, salt: this.#salt.toString('base64'), entries }, null, 2) + '\n';
  }

  /** Load entries from a serialized blob without unlocking. */
  deserialize(blob) {
    let doc;
    try { doc = JSON.parse(blob); } catch (e) { throw new Error('vault file is not valid JSON: ' + e.message); }
    if (doc.version !== VERSION) throw new Error(`unsupported vault version ${doc.version} (expected ${VERSION})}`);
    if (!doc.salt || typeof doc.salt !== 'string') throw new Error('vault header missing salt');
    if (!doc.entries || typeof doc.entries !== 'object') throw new Error('vault header missing entries');
    for (const [name, entry] of Object.entries(doc.entries)) {
      assertEnvName(name);
      if (!entry || typeof entry.iv !== 'string' || typeof entry.ct !== 'string') {
        throw new Error(`corrupted entry "${name}" in vault`);
      }
      this.#entries.set(name, entry);
    }
    return this;
  }

  /** Salt from an existing file, or a fresh one for a new project. */
  static saltFromBlob(blob) {
    let doc;
    try { doc = JSON.parse(blob); } catch { return null; }
    if (doc.version !== VERSION || typeof doc.salt !== 'string') return null;
    const salt = Buffer.from(doc.salt, 'base64');
    return salt.length === 16 ? salt : null;
  }

  static newSalt() { return randomBytes(16); }

  /** Load + unlock in one call. Throws on wrong passphrase (GCM tag mismatch). */
  static open(passphrase, blob) {
    const salt = Vault.saltFromBlob(blob);
    if (!salt) throw new Error('no readable vault header — run `nexus secrets init` first');
    const v = new Vault();
    v.unlock(passphrase, salt);
    v.deserialize(blob);
    return v;
  }

  /** Fresh vault with a new salt for a project that has none yet. */
  static create(passphrase) {
    const v = new Vault();
    v.unlock(passphrase, Vault.newSalt());
    return v;
  }
}

/** Same env-name rule as SecretStore — vault names map 1:1 onto env vars. */
function assertEnvName(name) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new TypeError(`secret name must be UPPER_SNAKE (got "${name}")`);
  }
}
