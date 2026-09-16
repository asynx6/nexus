import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { SecretStore } from '../index.js';

test('names must be UPPER_SNAKE env style', () => {
  const s = new SecretStore();
  s.set('OPENAI_API_KEY', 'sk-test');
  assert.throws(() => s.set('lower_key', 'x'), TypeError);
  assert.throws(() => s.set('OPENAI_API_KEY', ''), TypeError);
  assert.deepStrictEqual(s.names(), ['OPENAI_API_KEY']);
});

test('inject merges only requested secrets into env; unknown name throws', () => {
  const s = new SecretStore();
  s.set('A_TOKEN', 'a');
  s.set('B_TOKEN', 'b');
  const env = s.inject(['A_TOKEN'], { PATH: '/usr/bin' });
  assert.deepStrictEqual(env, { PATH: '/usr/bin', A_TOKEN: 'a' });
  assert.strictEqual(env.B_TOKEN, undefined);
  assert.throws(() => s.inject(['NOPE']), /unknown secret/);
});

test('withTempFile: file readable inside callback, erased after (even on throw)', async () => {
  const s = new SecretStore();
  s.set('MY_KEY', 'topsecret');
  let captured, gone;
  await s.withTempFile('MY_KEY', (p) => {
    captured = readFileSync(p, 'utf8');
    gone = p;
  });
  assert.strictEqual(captured, 'topsecret');
  assert.strictEqual(existsSync(gone), false);

  await assert.rejects(
    s.withTempFile('MY_KEY', () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.strictEqual(existsSync(gone), false);
});
