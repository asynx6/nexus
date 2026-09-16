import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('memory skeleton loads', () => {
  assert.strictEqual(NAME, '@nexus/memory');
});
