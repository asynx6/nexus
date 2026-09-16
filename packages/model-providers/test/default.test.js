import { test } from 'node:test';
import assert from 'node:assert';
import { ModelProvider } from '../src/provider.js';

test('default model is hermes-agent (single, simple)', () => {
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k' });
  assert.deepStrictEqual(p.models, ['hermes-agent']);
});

test('caller can still pass fallback chain explicitly', () => {
  const p = new ModelProvider({
    baseUrl: 'https://api.test',
    apiKey: 'k',
    models: ['hermes-agent', 'im/auto'],
  });
  assert.deepStrictEqual(p.models, ['hermes-agent', 'im/auto']);
});

test('no default model references dead providers', () => {
  const p = new ModelProvider({ baseUrl: 'https://api.test', apiKey: 'k' });
  for (const m of p.models) {
    assert.ok(!m.includes('qwen'), `default ${m} references dead qwen`);
    assert.ok(!m.includes('bai/'), `default ${m} references dead b.ai`);
  }
});
