// License key store — append-only JSONL for issued keys, in-memory index.
// Key format: NEXUS-<TIER>-<HEX32> where TIER is FREE/PRO/ENTERPRISE.
// Keys are validated via HMAC-SHA256 against a server secret so they can't be
// forged client-side.
//
// Store keeps: { key, tier, issuedAt, activatedAt?, device?, revoked? }

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TIERS = ['free', 'pro', 'enterprise'];

/** Generate a signed license key for a tier. */
export function createLicenseKey(secret, tier, issuedAt = new Date().toISOString()) {
  if (!TIERS.includes(tier)) throw new TypeError(`tier must be one of ${TIERS.join(', ')}`);
  const body = `NEXUS-${tier.toUpperCase()}-${randomBytes(16).toString('hex').toUpperCase()}`;
  const sig = sign(secret, body);
  return `${body}-${sig}`;
}

/** Split a key into body + hmac and verify the signature. */
export function verifyLicenseKey(secret, key) {
  if (typeof key !== 'string' || !/^NEXUS-(FREE|PRO|ENTERPRISE)-[0-9A-F]{32}-[0-9a-f]{64}$/.test(key)) {
    return { ok: false, reason: 'malformed' };
  }
  const body = key.slice(0, key.lastIndexOf('-'));
  const sig = key.slice(key.lastIndexOf('-') + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }
  const tier = key.split('-')[1].toLowerCase();
  return { ok: true, tier };
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export class LicenseStore {
  #secret;
  #path;
  #records = new Map(); // key -> record

  /**
   * @param {{ path: string, secret: string, seedPro?: string[], seedEnterprise?: string[] }} opts
   *   - path: JSONL file of issued keys
   *   - secret: HMAC key used to sign/verify license bodies
   *   - seedPro / seedEnterprise: optional pre-authorized key strings to seed on first boot
   */
  constructor({ path, secret, seedPro = [], seedEnterprise = [] }) {
    if (!path) throw new TypeError('path required');
    if (!secret || Buffer.byteLength(secret) < 32) throw new TypeError('secret must be >= 32 bytes');
    this.#path = path;
    this.#secret = secret;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
    this.#load();
    this.#seed(seedPro, 'pro');
    this.#seed(seedEnterprise, 'enterprise');
  }

  #load() {
    const text = readFileSync(this.#path, 'utf8');
    this.#records.clear();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      this.#records.set(rec.key, rec);
    }
  }

  #seed(keys, tier) {
    for (const k of keys) {
      const [bodyPart] = k.split('|');
      const bodyKey = bodyPart || k;
      const v = verifyLicenseKey(this.#secret, bodyKey);
      if (v.ok && !this.#records.has(bodyKey)) {
        this.#records.set(bodyKey, { key: bodyKey, tier, issuedAt: new Date().toISOString(), activatedAt: null, device: null, revoked: false });
        this.#persist();
      }
    }
  }

  #persist() {
    const lines = [...this.#records.values()].map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(this.#path, lines + (lines ? '\n' : ''));
  }

  get secret() {
    return this.#secret;
  }

  /** Issue a new key for a tier. */
  issue(tier) {
    const key = createLicenseKey(this.#secret, tier);
    const rec = { key, tier, issuedAt: new Date().toISOString(), activatedAt: null, device: null, revoked: false };
    this.#records.set(key, rec);
    this.#persist();
    return rec;
  }

  /** Look up a record by key. */
  get(key) {
    return this.#records.get(key) ?? null;
  }

  /** Verify a key signature and return tie + activation status. */
  verify(key) {
    const sig = verifyLicenseKey(this.#secret, key);
    if (!sig.ok) return { ok: false, reason: sig.reason };
    const rec = this.#records.get(key);
    if (!rec) return { ok: false, reason: 'unknown key' };
    if (rec.revoked) return { ok: false, reason: 'revoked' };
    return { ok: true, tier: rec.tier, key, activated: !!rec.activatedAt };
  }

  /**
   * Activate a key for a device. A key can be activated on multiple devices
   * (device list) unless already activated elsewhere — single-activation policy.
   * @param {string} key
   * @param {string} device machine identifier
   * @param {{ allowMultiDevice?: boolean }} [opts] re-activate on another machine
   */
  activate(key, device, opts = {}) {
    const v = this.verify(key);
    if (!v.ok) return { ok: false, reason: v.reason };
    const rec = this.#records.get(key);
    if (rec.activatedAt && rec.device && rec.device !== device && !opts.allowMultiDevice) {
      return { ok: false, reason: 'already activated on ' + rec.device };
    }
    const prev = rec.device || null;
    rec.activatedAt = rec.activatedAt ?? new Date().toISOString();
    rec.device = device;
    rec.devices = rec.devices || [];
    if (!rec.devices.includes(device)) rec.devices.push(device);
    this.#persist();
    return { ok: true, key, tier: rec.tier, activatedAt: rec.activatedAt, device, previousDevice: prev };
  }

  /** Deactivate a key (release it for another machine). */
  deactivate(key, device) {
    const rec = this.#records.get(key);
    if (!rec) return { ok: false, reason: 'unknown key' };
    if (device && rec.device !== device) return { ok: false, reason: 'not activated on this device' };
    rec.activatedAt = null;
    rec.device = null;
    this.#persist();
    return { ok: true, key, tier: rec.tier };
  }

  /** Revoke a key permanently. */
  revoke(key) {
    const rec = this.#records.get(key);
    if (!rec) return { ok: false, reason: 'unknown key' };
    rec.revoked = true;
    this.#persist();
    return { ok: true, key };
  }

  /** All records (admin listing). */
  list() {
    return [...this.#records.values()];
  }
}