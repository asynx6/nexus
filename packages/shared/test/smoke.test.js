import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('shared skeleton loads', () => {
  assert.strictEqual(NAME, '@nexus/shared');
});
