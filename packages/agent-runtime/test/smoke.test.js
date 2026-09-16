import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('agent-runtime skeleton loads', () => {
  assert.strictEqual(NAME, '@nexus/agent-runtime');
});
