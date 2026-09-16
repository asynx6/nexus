// Agent loop (plan sec 8): task -> LLM with tool schemas -> parse tool_calls ->
// permission gate -> tool execute -> feed results back -> repeat until final
// answer or maxSteps. Every step emits events on the EventBus (sec 11).
//
// ToolManager contract (implemented by @nexus/tool-system, mocked in tests):
//   list() -> [{ name, description, parameters }]        // JSON schemas
//   execute(name, args, ctx) -> { ok, output } | throws  // ctx: { agentId, sandbox }
// Permission contract (@nexus/security PermissionManager):
//   check(agentId, tool, args) -> { allowed, reason, ... }

import { EVENTS, makeEvent } from '@nexus/event-system';

export class AgentLoop {
  #provider; #tools; #permissions; #audit; #bus; #model;

  /**
   * @param {{ provider: {chat: Function}, tools: {list: Function, execute: Function},
   *           permissions?: {check: Function}, audit?: {logDecision: Function},
   *           bus?: {emit: Function}, model?: string }} deps
   */
  constructor({ provider, tools, permissions = null, audit = null, bus = null, model = null }) {
    if (!provider?.chat) throw new TypeError('provider with chat() required');
    if (!tools?.list || !tools?.execute) throw new TypeError('tools with list()/execute() required');
    this.#provider = provider;
    this.#tools = tools;
    this.#permissions = permissions;
    this.#audit = audit;
    this.#bus = bus;
    this.#model = model;
  }

  #emit(name, data, subject = null) {
    if (!this.#bus) return;
    try { this.#bus.emit(makeEvent(name, data, subject)); } catch { /* observability must never kill the loop */ }
  }

  /**
   * Run a task to completion.
   * @param {string} task user-visible goal
   * @param {{ agentId: string, sandbox?: unknown, maxSteps?: number, system?: string }} ctx
   * @returns {Promise<{ done: boolean, answer: string|null, steps: number, history: Array }>}
   */
  async run(task, { agentId, sandbox = null, maxSteps = 16, system, ...toolCtx } = {}) {
    if (typeof task !== 'string' || !task.trim()) throw new TypeError('task required');
    if (!agentId) throw new TypeError('agentId required');

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: task });

    const schemas = this.#tools.list();
    this.#emit(EVENTS.TASK_CREATED, { task, agentId }, agentId);
    this.#emit(EVENTS.AGENT_STARTED, { agentId, maxSteps }, agentId);

    let steps = 0;
    for (; steps < maxSteps; steps++) {
      const res = await this.#provider.chat(messages, { model: this.#model ?? undefined, tools: schemas.length ? schemas : undefined });
      const call = res.tool_call ?? null;
      const content = res.content ?? null;
      this.#emit('agent.step', { step: steps, model: res.model, usedTool: !!call }, agentId);

      if (!call) {
        // no tool call -> final answer
        if (content) messages.push({ role: 'assistant', content });
        this.#emit(EVENTS.TASK_COMPLETED, { steps: steps + 1, answerLength: (content || '').length }, agentId);
        return { done: true, answer: content, steps: steps + 1, history: messages };
      }

      const { name, arguments: args = {} } = call;
      messages.push({
        role: 'assistant',
        content: content ?? '',
        tool_calls: [{ id: call.id || 'call_' + steps, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      });
      this.#emit(EVENTS.AGENT_TOOL_CALLED, { tool: name, args }, agentId);

      const toolMsg = (ok, out) => ({ role: 'tool', tool_call_id: call.id || 'call_' + steps, content: out, ok });

      // permission gate (deny-by-default when permissions provided)
      if (this.#permissions) {
        const decision = this.#permissions.check(agentId, name, args);
        this.#audit?.logDecision?.(decision);
        if (!decision.allowed) {
          messages.push(toolMsg(false, 'PERMISSION DENIED: ' + decision.reason));
          this.#emit('agent.tool_denied', { tool: name, reason: decision.reason }, agentId);
          continue;
        }
      }

      let result;
      try {
        // forward toolCtx (runtime, sandboxId, bus, env) untouched — the
        // ToolExecutor funnel owns permission/audit/event wiring (P07b).
        result = await this.#tools.execute(name, args, { agentId, sandbox, ...toolCtx });
        messages.push(toolMsg(true, stringify(result?.output)));
      } catch (e) {
        messages.push(toolMsg(false, 'TOOL ERROR: ' + e.message));
      }
      this.#emit('agent.tool_result', { tool: name, ok: !!result?.ok }, agentId);
    }

    this.#emit('agent.exhausted', { maxSteps }, agentId);
    return { done: false, answer: null, steps, history: messages };
  }
}

const stringify = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
