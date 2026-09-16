import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('security skeleton loads', () => {
  assert.strictEqual(NAME, '@nexus/security');
});
