// ToolExecutor — the single funnel every tool call passes through:
// registry lookup -> arg validation -> PermissionManager check -> audit ->
// events (agent.tool_called / agent.tool_finished) -> handler with hard
// timeout. Denials and validation failures are RESULTS, never thrown
// exceptions, so the agent loop can feed them back to the model (plan P05:
// "tool tanpa izin ditolak dengan event reason").
import { EVENTS, newEventId } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';

/** Escape hatch: emit an event with an arbitrary canonical name. */
function emit(ctx, name, data) {
  if (!ctx.bus) return;
  ctx.bus.emit(makeEvent(name, data, ctx.agentId ?? null));
}

export class ToolExecutor {
  #registry;
  #permissions;
  #audit;

  /**
   * @param {{ registry: import('./registry.js').ToolRegistry,
   *   permissions?: import('@nexus/security').PermissionManager,
   *   audit?: import('@nexus/security').AuditTrail }} opts
   *   permissions/audit optional for pure unit tests; production wiring
   *   always supplies both (deny-by-default comes from PermissionManager).
   */
  constructor({ registry, permissions = null, audit = null }) {
    if (!registry) throw new TypeError('registry required');
    this.#registry = registry;
    this.#permissions = permissions;
    this.#audit = audit;
  }

  /**
   * @param {object} call { tool, args } (model-facing shape) or name/params
   * @param {{ agentId: string, sandboxId?: string, bus?: object,
   *   runtime?: object, env?: Record<string,string> }} ctx
   * @returns {Promise<{ ok: boolean, tool: string, result?: object,
   *   error?: string, reason?: string, durationMs: number }>}
   */
  async execute(call, ctx = {}) {
    const started = Date.now();
    const name = call?.tool ?? call?.name;
    const args = call?.args ?? call?.params ?? {};
    const base = { tool: String(name ?? 'unknown') };

    const tool = this.#registry.get(name);
    if (!tool) {
      return this.#finish(ctx, base, { ok: false, error: 'validation', reason: `unknown tool: ${name}`, durationMs: Date.now() - started });
    }

    const schemaErrors = this.#registry.validate(name, args);
    if (schemaErrors.length > 0) {
      return this.#finish(ctx, base, { ok: false, error: 'validation', reason: schemaErrors.join('; '), durationMs: Date.now() - started });
    }

    if (this.#permissions) {
      const decision = this.#permissions.check(ctx.agentId, tool.permission, args);
      if (this.#audit) this.#audit.logDecision(decision);
      emit(ctx, EVENTS.PERMISSION_DECISION, {
        tool: tool.name, permission: tool.permission,
        allowed: decision.allowed, reason: decision.reason,
      });
      if (!decision.allowed) {
        return this.#finish(ctx, base, { ok: false, error: 'denied', reason: decision.reason, durationMs: Date.now() - started });
      }
    }

    emit(ctx, EVENTS.AGENT_TOOL_CALLED, { tool: tool.name, args });
    try {
      const result = await this.#withTimeout(tool.handler(args, { ...ctx, tool }), tool.timeoutMs);
      return this.#finish(ctx, base, { ok: true, result, durationMs: Date.now() - started });
    } catch (err) {
      const reason = err?.message === '__tool_timeout__' ? `tool timed out after ${tool.timeoutMs}ms` : String(err?.message ?? err);
      return this.#finish(ctx, base, { ok: false, error: 'handler', reason, durationMs: Date.now() - started });
    }
  }

  #withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('__tool_timeout__'), { timedOut: true })), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  #finish(ctx, base, out) {
    emit(ctx, EVENTS.AGENT_TOOL_FINISHED, {
      tool: base.tool, ok: out.ok,
      error: out.error ?? null, reason: out.ok ? null : out.reason,
      duration_ms: out.durationMs,
    });
    return { ...base, ...out };
  }
}
