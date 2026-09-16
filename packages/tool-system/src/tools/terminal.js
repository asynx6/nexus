// terminal.exec — run a command inside the sandbox via SandboxRuntime.exec.
// Secrets (ctx.env) are injected at exec time only (P04 isolation): they
// reach the process environment, never args, events, or disk.
import { EVENTS } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';
import { requireSandbox } from './_sandbox.js';

const MAX_OUTPUT = 200_000; // keep tool_result payloads bounded for the model

function clip(s) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n[... clipped ${s.length - MAX_OUTPUT} bytes]` : s;
}

export function terminalTools() {
  return [
    {
      name: 'terminal.exec',
      description: 'Execute a command inside the sandbox. Returns exit code, stdout, stderr.',
      permission: 'terminal.exec',
      timeoutMs: 120_000,
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'program to run (argv style, no shell interpolation unless using sh -c)' },
          args: { type: 'array', items: { type: 'string' } },
          workdir: { type: 'string' },
          timeoutMs: { type: 'integer', description: 'hard cap, defaults to the tool timeout' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId } = requireSandbox(ctx);
        const cmd = [args.command, ...(args.args ?? [])];
        const bus = ctx.bus;
        const subject = ctx.agentId ?? null;
        if (bus) bus.emit(makeEvent(EVENTS.TERMINAL_STARTED, { command: cmd.join(' '), sandboxId }, subject));
        const r = await runtime.exec(sandboxId, cmd, {
          timeoutMs: Number.isInteger(args.timeoutMs) ? Math.min(args.timeoutMs, 120_000) : undefined,
          workdir: args.workdir,
          env: ctx.env,
        });
        if (bus) bus.emit(makeEvent(EVENTS.TERMINAL_FINISHED, { command: cmd.join(' '), exit_code: r.exitCode, timed_out: r.timedOut }, subject));
        if (r.timedOut) throw new Error(`command timed out (${cmd.join(' ')})`);
        return { exitCode: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr), timedOut: r.timedOut };
      },
    },
  ];
}
