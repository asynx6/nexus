// Audit trail: every permission decision becomes an event on the EventBus
// (plan sec 6: "Setiap tool invocation harus dapat menghasilkan audit event").
// Uses the approved custom-type convention (dot.separated_kind), security.* namespace.
import { makeEvent } from '@nexus/event-system';

const SECRET_RE = /(token|secret|password|passwd|api[-_]?key|authorization)/i;

export function redact(obj) {
  if (obj === null || typeof obj !== 'object') {
    return typeof obj === 'string' && SECRET_RE.test(obj) ? '[redacted]' : obj;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_RE.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

export class AuditTrail {
  #bus;
  #runId;

  /**
   * @param {{ bus: import('@nexus/event-system').EventBus, runId: string }} opts
   */
  constructor({ bus, runId }) {
    if (!bus || typeof bus.emit !== 'function') throw new TypeError('bus with emit required');
    if (typeof runId !== 'string' || !runId) throw new TypeError('runId required');
    this.#bus = bus;
    this.#runId = runId;
  }

  /** Log one PermissionManager.check() decision. Returns the stored event. */
  logDecision(decision) {
    if (!decision || typeof decision.allowed !== 'boolean') {
      throw new TypeError('decision must come from PermissionManager.check()');
    }
    const ev = makeEvent('security.permission_checked', {
      agentId: decision.agentId,
      tool: decision.tool,
      allowed: decision.allowed,
      reason: decision.reason,
      args: redact(decision.args),
    }, this.#runId);
    this.#bus.emit(ev);
    return ev;
  }

  /** Log a security-relevant occurrence that is not a decision (e.g. secret access). */
  logEvent(type, payload = {}) {
    const ev = makeEvent(type, redact(payload), this.#runId);
    this.#bus.emit(ev);
    return ev;
  }
}
