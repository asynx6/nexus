// @nexus/event-system — EventBus + append-only EventStore (JSONL + node:sqlite index), replay iterator.
// Event contracts come from @nexus/shared; re-exported here for convenience.
// public facade: export ONLY contracts here (see docs/ARCHITECTURE.md rule 4)
export const NAME = '@nexus/event-system';
export { EVENTS, EVENT_SCHEMA_VERSION, makeEvent, isEnvelope } from './src/events.js';
export { EventBus } from './src/bus.js';
export { EventStore } from './src/store.js';

// Optional DB adapters (D3): SQLite default, PG/MySQL/Mongo via NEXUS_DB_URL.
// Driver modules are loaded lazily — installing optional deps is opt-in.
export {
  createDbAdapter,
  parseDbUrl,
  listSupportedSchemes,
} from './src/db/factory.js';
