// @nexus/security — PermissionManager (deny-by-default) + audit events + secret isolation
// public facade: export ONLY contracts here (see docs/ARCHITECTURE.md rule 4)
export const NAME = '@nexus/security';
export { PermissionManager } from './src/permissions.js';
export { AuditTrail, redact } from './src/audit.js';
export { SecretStore } from './src/secrets.js';
