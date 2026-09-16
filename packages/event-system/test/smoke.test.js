import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('event-system skeleton loads', () => {
  assert.strictEqual(NAME, '@nexus/event-system');
});
