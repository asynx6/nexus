import { test } from 'node:test';
import assert from 'node:assert';
import { Vault, ProjectSecrets } from '../index.js';
import { SecretStore } from '../index.js';

const PASS = 'correct horse battery staple';
const WRONG = 'hunter2';

test('roundtrip: unlock with the right passphrase, set/get works', () => {
  const v = Vault.create(PASS);
  v.set('OPENAI_API_KEY', 'sk-abc');
  assert.strictEqual(v.get('OPENAI_API_KEY'), 'sk-abc');
  assert.deepStrictEqual(v.names(), ['OPENAI_API_KEY']);
});

test('wrong passphrase on an existing file fails loudly, never returns garbage', () => {
  const v1 = Vault.create(PASS);
  v1.set('DB_PASSWORD', 's3cret');
  const blob = v1.serialize();
  const good = Vault.open(PASS, blob);
  assert.strictEqual(good.get('DB_PASSWORD'), 's3cret');
  // open() only loads envelopes; the wrong key fails at decrypt time.
  const bad = Vault.open(WRONG, blob);
  assert.throws(() => bad.get('DB_PASSWORD'), /decrypt failed/);
});

test('tampered ciphertext is rejected (GCM auth tag)', () => {
  const v = Vault.create(PASS);
  v.set('TOKEN', 'val');
  const doc = JSON.parse(v.serialize());
  const buf = Buffer.from(doc.entries.TOKEN.ct, 'base64');
  buf[0] ^= 0xff; // flip a bit
  doc.entries.TOKEN.ct = buf.toString('base64');
  assert.throws(() => Vault.open(PASS, JSON.stringify(doc)).get('TOKEN'), /decrypt failed/);
});

test('two projects sharing a passphrase get different ciphertext (per-project salt)', () => {
  const a = Vault.create(PASS);
  const b = Vault.create(PASS);
  a.set('K', 'same-value'); b.set('K', 'same-value');
  const blobA = a.serialize();
  const blobB = b.serialize();
  assert.notDeepStrictEqual(JSON.parse(blobA).salt, JSON.parse(blobB).salt);
  // identical value + identical passphrase, but ciphertexts differ
  assert.notDeepStrictEqual(JSON.parse(blobA).entries.K, JSON.parse(blobB).entries.K);
  // each project reads its own blob with the same passphrase
  assert.strictEqual(Vault.open(PASS, blobA).get('K'), 'same-value');
  assert.strictEqual(Vault.open(PASS, blobB).get('K'), 'same-value');
  // A's derived key cannot decrypt B's entry (cross-project ciphertext swap)
  const mixed = { ...JSON.parse(blobB), entries: JSON.parse(blobA).entries };
  assert.throws(() => Vault.open(PASS, JSON.stringify(mixed)).get('K'), /decrypt failed/);
});

test('version + shape validation on deserialize', () => {
  assert.throws(() => new Vault().deserialize('{not json'), /not valid JSON/);
  assert.throws(() => new Vault().deserialize(JSON.stringify({ version: 99 })), /unsupported vault version/);
  assert.throws(() => new Vault().deserialize(JSON.stringify({ version: 1 })), /missing salt/);
  assert.throws(() => Vault.open(PASS, JSON.stringify({ version: 1, salt: 'x', entries: {} })), /no readable vault header/);
});

test('locked vault refuses all crypto ops', () => {
  const v = new Vault();
  assert.strictEqual(v.locked, true);
  assert.throws(() => v.set('A', 'b'), /locked/);
  assert.throws(() => v.encryptValue('x'), /locked/);
});

test('name validation is identical to SecretStore (UPPER_SNAKE)', () => {
  const v = Vault.create(PASS);
  assert.throws(() => v.set('lower', 'x'), TypeError);
  assert.throws(() => v.set('HAS SPACE', 'x'), TypeError);
});

test('serialize roundtrip preserves names and values', () => {
  const v = Vault.create(PASS);
  v.set('Z_LAST', 'z'); v.set('A_FIRST', 'a'); v.set('M_MID', 'm');
  const blob = v.serialize();
  const back = Vault.open(PASS, blob);
  assert.deepStrictEqual(back.names(), ['A_FIRST', 'M_MID', 'Z_LAST']);
  assert.strictEqual(back.get('Z_LAST'), 'z');
  back.delete('M_MID');
  assert.deepStrictEqual(back.names(), ['A_FIRST', 'Z_LAST']);
});

// ---- ProjectSecrets RBAC ----

function rbac(names = []) {
  const v = Vault.create(PASS);
  const secrets = new ProjectSecrets({ vault: v });
  for (const n of names) v.set(n, 'val:' + n);
  return { v, secrets };
}

test('envFor injects only granted names; ungranted names throw', () => {
  const { secrets } = rbac(['A_TOKEN', 'B_TOKEN']);
  secrets.grant('agent-1', 'A_TOKEN');
  const env = secrets.envFor('agent-1', ['A_TOKEN'], { PATH: '/bin' });
  assert.deepStrictEqual(env, { PATH: '/bin', A_TOKEN: 'val:A_TOKEN' });
  assert.strictEqual(env.B_TOKEN, undefined);
  assert.throws(() => secrets.envFor('agent-1', ['B_TOKEN']), /access denied/);
});

test('unknown principal with no grants gets denial for everything', () => {
  const { secrets } = rbac(['A_TOKEN']);
  assert.deepStrictEqual(secrets.grantsFor('nobody'), []);
  assert.throws(() => secrets.envFor('nobody', ['A_TOKEN']), /access denied/);
});

test('granted but missing from vault is a loud config error', () => {
  const { secrets } = rbac();
  secrets.grant('agent-1', 'GHOST');
  assert.throws(() => secrets.envFor('agent-1', ['GHOST']), /not present in vault/);
});

test('revoke removes access', () => {
  const { secrets } = rbac(['A_TOKEN']);
  secrets.grant('agent-1', 'A_TOKEN');
  assert.deepStrictEqual(secrets.grantsFor('agent-1'), ['A_TOKEN']);
  secrets.revoke('agent-1', 'A_TOKEN');
  assert.deepStrictEqual(secrets.grantsFor('agent-1'), []);
  assert.throws(() => secrets.envFor('agent-1', ['A_TOKEN']), /access denied/);
});

test('principals are isolated from each other', () => {
  const { secrets } = rbac(['SHARED', 'PRIVATE']);
  secrets.grant('agent-a', 'SHARED');
  secrets.grant('agent-b', 'SHARED');
  secrets.grant('agent-b', 'PRIVATE');
  assert.deepStrictEqual(secrets.grantsFor('agent-a'), ['SHARED']);
  assert.deepStrictEqual(secrets.grantsFor('agent-b'), ['PRIVATE', 'SHARED']);
  assert.throws(() => secrets.envFor('agent-a', ['PRIVATE']), /access denied/);
});

test('secret names are validated in RBAC too', () => {
  const { secrets } = rbac();
  assert.throws(() => secrets.grant('agent-1', 'lowercase'), TypeError);
  assert.throws(() => secrets.grant('bad principal!', 'A_TOKEN'), TypeError);
});

test('setAndGrant sets value and grant together', () => {
  const { v, secrets } = rbac();
  secrets.setAndGrant('agent-1', 'NEW_KEY', 'plaintext');
  assert.strictEqual(v.get('NEW_KEY'), 'plaintext');
  assert.deepStrictEqual(secrets.grantsFor('agent-1'), ['NEW_KEY']);
});

test('RBAC decisions emit audit events on the bus', () => {
  const events = [];
  const bus = { emit: (e) => events.push(e) };
  const v = Vault.create(PASS);
  v.set('A_TOKEN', 'val');
  const secrets = new ProjectSecrets({ vault: v, bus });
  secrets.grant('agent-1', 'A_TOKEN');
  secrets.envFor('agent-1', ['A_TOKEN']);
  const names = events.map((e) => e.name);
  assert.ok(names.includes('secrets.grant'));
  assert.ok(names.includes('secrets.access'));
  const access = events.find((e) => e.name === 'secrets.access');
  assert.deepStrictEqual(access.data.granted, ['A_TOKEN']);
  assert.deepStrictEqual(access.data.denied, []);
  // no value ever lands in the event payload
  assert.ok(JSON.stringify(access.data).indexOf('val') === -1, 'plaintext leaked into audit event');
});

test('SecretStore still works unchanged (P04 regression)', () => {
  const s = new SecretStore();
  s.set('X', 'y');
  assert.strictEqual(s.inject(['X'], {}).X, 'y');
});
