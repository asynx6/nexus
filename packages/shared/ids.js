// Entity ids: <prefix>-<8 hex>. Deterministic prefix helps event routing.
import { randomBytes } from 'node:crypto';

export const newId = (prefix) => prefix + '-' + randomBytes(4).toString('hex');
export const newAgentId = () => newId('agent');
export const newSandboxId = () => newId('sandbox');
export const newTaskId = () => newId('task');
export const newEventId = () => newId('evt');
