import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('model-providers skeleton loads', () => {
  assert.strictEqual(NAME, '@nexus/model-providers');
});
