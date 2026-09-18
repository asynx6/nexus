// Helper: build a ConsensusProvider from a base ModelProvider + env.
// Reads NEXUS_CONSENSUS_MODELS (comma-sep). Returns a base provider when unset
// or only one model is configured (no consensus overhead).
//
// Usage:
//   const provider = makeConsensusFromEnv({ provider, env, bus, subject });
//   const res = await provider.chat(messages, opts);  // same interface as ModelProvider

import { ConsensusProvider, parseConsensusModels } from './consensus.js';

export function makeConsensusFromEnv({ provider, env = process.env, bus = null, subject = null } = {}) {
  if (!provider) throw new TypeError('provider required');
  const models = parseConsensusModels(env?.NEXUS_CONSENSUS_MODELS);
  if (!models || models.length <= 1) {
    // no consensus — return as-is (or set explicit single model)
    if (models?.length === 1) {
      // wrap anyway so CONSENSUS_VERDICT event fires in single mode for log consistency
      return new ConsensusProvider({ provider, models, bus, subject });
    }
    return provider;
  }
  return new ConsensusProvider({ provider, models, bus, subject });
}
