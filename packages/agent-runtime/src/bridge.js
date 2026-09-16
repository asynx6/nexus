// Bridge @nexus/tool-system's ToolExecutor into the AgentLoop's tools contract.
// The executor is the single funnel (validation + permissions + audit +
// events + timeout); the loop therefore runs WITHOUT its own permission gate
// when wired through this adapter — no double checks, no double audit rows.
import { ToolRegistry, ToolExecutor } from '@nexus/tool-system';

/**
 * @param {{ registry: ToolRegistry, executor: ToolExecutor }} parts
 * @returns {{ list(): Array<{name,description,parameters}>,
 *   execute(name: string, args: object, ctx: object): Promise<{ok: boolean, output: string}> }}
 */
export function loopTools({ registry, executor }) {
  if (!registry || !executor) throw new TypeError('registry + executor required');
  return {
    // plain schema list (provider wraps into OpenAI shape itself)
    list: () => registry.list().map((t) => ({ name: t.name, description: t.description, parameters: t.schema })),
    async execute(name, args, ctx) {
      const out = await executor.execute({ tool: name, args }, ctx);
      const output = out.ok
        ? (typeof out.result === 'string' ? out.result : JSON.stringify(out.result ?? {}))
        : ((out.error === 'denied' ? 'PERMISSION DENIED: ' : out.error === 'validation' ? 'INVALID CALL: ' : 'TOOL ERROR: ') + (out.reason ?? 'unknown'));
      return { ok: out.ok, output };
    },
  };
}
