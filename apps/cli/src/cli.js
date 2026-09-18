// @nexus/cli dispatcher — parses argv, dispatches to subcommands.
// Zero deps. Returns exit code.

import { buildRunCtx, buildReplayCtx } from './ctx.js';
import { runDoctor, runDoctorFix } from './doctor.js';
import { runAudit } from './audit.js';
import { scaffoldProject, parseInitArgs } from './init.js';
import { installGracefulShutdown as installCliGraceful } from './graceful.js';
import { makeEvent } from '@nexus/event-system';
import { newAgentId, newTaskId } from '@nexus/shared';
import { createReplayServer } from '@nexus/event-system/replay-server.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `nexus — AI Agent Operating Environment
Usage:
  nexus run "<task>" [--max-steps=N] [--model=NAME]      run agent on a task
  nexus replay [--subject=ID] [--since=SEQ] [--follow]   replay events from store
                                                          --follow tails live events (poll default 1s)
  nexus replay --port N [--host=H] [--no-open]           serve browser-based event timeline UI on :N
                                                          (open http://H:N/ in a browser)
  nexus tasks                                            list recent task subjects
  nexus healthz                                          check gateway reachability
  nexus doctor [--fix]                                     full environment health check (Node, env, gateway, sqlite, docker). --fix auto-repairs common setup issues
  nexus init <name> [--yes]                              scaffold a new NEXUS project skeleton
  nexus --help                                           show this message

Env (read from .env-gateway or process env):
  NEXUS_GATEWAY_BASE      gateway base URL
  NEXUS_GATEWAY_KEY       gateway API key
  NEXUS_GATEWAY_MODELS    comma-separated fallback models

Subcommand shortcuts:
  nexus <task text>       if first arg is not a subcommand, treated as 'nexus run <task>'
`;

/** Parse argv into {cmd, task, flags}. Minimal: handles --key=value, --flag value, positional. */
export function parseArgs(argv) {
  const out = { cmd: 'help', task: '', flags: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { out.flags[a.slice(2)] = argv[++i]; }
      else out.flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  if (positional.length) {
    out.cmd = positional[0];
    out.task = positional.slice(1).join(' ');
  }
  return out;
}

function readFlags(flags, ...keys) {
  for (const k of keys) {
    const v = flags[k];
    if (v === undefined || v === '') continue;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return undefined;
}

/** Run the CLI. Returns 0 on success, non-zero on error. */
export async function runNexusCli(argv, env = process.env, stdout = console.log, stderr = console.error) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { stderr('parse: ' + e.message); return 2; }

  if (args.cmd === 'help' || args.cmd === '--help' || args.cmd === '-h') {
    stdout(HELP);
    return 0;
  }

  if (args.cmd === 'healthz') {
    try {
      const base = env.NEXUS_GATEWAY_BASE ?? 'https://api.asynx6.tech/v1';
      const r = await fetch(base.replace(/\/v1$/, '') + '/healthz', { signal: AbortSignal.timeout(5000) }).catch(() => null);
      stdout(`gateway reachable: ${r ? 'yes' : 'unknown'}`);
      stdout(`base: ${base}`);
      stdout(`models: ${env.NEXUS_GATEWAY_MODELS ?? 'hermes-agent'}`);
      return 0;
    } catch (e) { stderr('healthz: ' + e.message); return 1; }
  }

  if (args.cmd === 'doctor') {
    if (args.flags.fix) {
      const result = await runDoctorFix({ stdout, stderr });
      return result.actions.every((a) => a.ok) ? 0 : 1;
    }
    return await runDoctor({ env, stdout, stderr });
  }

  if (args.cmd === 'init') {
    let parsed;
    try { parsed = parseInitArgs(argv.slice(1)); }
    catch (e) { stderr('init: ' + e.message); return 2; }

    let answers;
    try {
      answers = parsed.yes
        ? { name: parsed.name, scope: '@' + parsed.name, provider: 'hermes-agent', sandbox: 'subprocess' }
        : await promptInitAnswers({ name: parsed.name, stdout, stderr });
    } catch (e) {
      stderr('init: ' + e.message);
      return 2;
    }

    const target = join(process.cwd(), parsed.name);
    try {
      await scaffoldProject({ target, answers, yes: parsed.yes, stdout, stderr });
      return 0;
    } catch (e) {
      stderr('init: ' + e.message);
      return 1;
    }
  }

  if (args.cmd === 'audit') {
    return await runAudit(argv.slice(1), env, stdout, stderr);
  }

  if (args.cmd === 'replay') {
    // Browser UI mode: --port[=N] (or positional 9090) opens the replay server.
    const portFlag = args.flags.port ?? args.flags['serve-port'];
    const hostFlag = args.flags.host ?? args.flags['serve-host'] ?? '127.0.0.1';
    const noOpen = !!args.flags['no-open'] || args.flags.noOpen === true;
    if (portFlag !== undefined || args.flags.ui === true) {
      const port = Number(portFlag ?? 9090);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) { stderr('replay: --port must be 1..65535'); return 2; }
      const ctx = buildReplayCtx();
      const store = await ctx.store.open();
      // resolve packages/event-system/public regardless of CWD: replay-server
      // is shipped inside the installed package, so we go up from this file.
      const here = dirname(fileURLToPath(import.meta.url));
      // here = apps/cli/src; publicDir = ../../packages/event-system/public
      // Walk up until we find a sibling packages/event-system/public; fall back to relative.
      let publicDir = resolve(here, '..', '..', '..', 'packages', 'event-system', 'public');
      // Soft fallback: CWD-relative path for source-tree runs.
      try {
        const fs = await import('node:fs');
        if (!fs.existsSync(publicDir)) {
          publicDir = resolve(process.cwd(), 'packages', 'event-system', 'public');
        }
      } catch { /* ignore */ }
      const srv = createReplayServer({ store, publicDir, host: String(hostFlag), port });
      let shutdown;
      try {
        await srv.listen();
        const url = `http://${srv.host}:${srv.port}/`;
        stdout(`nexus replay ui: ${url}`);
        stdout(`  serving static from ${publicDir}`);
        stdout(`  store: ${ctx.store.dir}/events.jsonl (count=${store.count()})`);
        stdout('  press Ctrl+C to stop');
        if (!noOpen) {
          try {
            const { spawn } = await import('node:child_process');
            const opener = process.platform === 'darwin' ? 'open'
              : process.platform === 'win32' ? 'start'
              : 'xdg-open';
            spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
          } catch { /* best-effort */ }
        }
        // SIGTERM/SIGINT -> close replay server + store cleanly
        shutdown = installCliGraceful({
          onClose: async () => { try { await srv.close(); } catch {} try { await store.close(); } catch {} },
        });
        await new Promise(() => {}); // run until SIGINT/SIGTERM
      } finally {
        if (shutdown) shutdown.uninstall();
        try { await srv.close(); } catch {}
        try { await store.close(); } catch {}
      }
      return 0;
    }
    const ctx = buildReplayCtx();
    const store = await ctx.store.open();
    const subject = args.flags.subject;
    const since = readFlags(args.flags, 'since');
    const follow = !!args.flags.follow;
    const interval = Number(args.flags.interval ?? 1000);
    try {
      let cursor = since;
      for (;;) {
        for await (const env of store.replay({ subject, since: cursor })) {
          stdout(JSON.stringify(env));
          cursor = (env.seq ?? 0) + 1;
        }
        if (!follow) break;
        await new Promise((r) => setTimeout(r, interval));
      }
      return 0;
    } finally { await store.close(); }
  }

  if (args.cmd === 'tasks') {
    const ctx = buildReplayCtx();
    const store = await ctx.store.open();
    try {
      const seen = new Map();
      for await (const e of store.replay({ name: 'task.started' })) {
        seen.set(e.subject, e.ts);
      }
      for (const [s, ts] of seen) stdout(ts, s);
      return 0;
    } finally { await store.close(); }
  }

  if (args.cmd === 'run' || (args.task && args.cmd === 'nexus')) {
    if (!args.task.trim()) { stderr('run: task text required'); return 2; }
    const ctx = buildRunCtx({ log: { info: stdout, warn: stderr, error: stderr, debug: () => {} } });
    const agentId = newAgentId();
    const taskId = newTaskId();
    const maxSteps = readFlags(args.flags, 'max-steps', 'maxSteps') ?? 16;
    const model = readFlags(args.flags, 'model');

    const started = makeEvent('task.started', { task: args.task, taskId, agentId }, taskId);
    await ctx.store.append(started);

    const loop = new AgentLoop({
      provider: ctx.provider,
      tools: ctx.tools,
      permissions: ctx.permissions,
      audit: ctx.audit,
      bus: ctx.bus,
      ...(model ? { model } : {}),
    });
    try {
      const result = await loop.run(args.task, {
        agentId,
        sandbox: null,
        maxSteps,
        system: 'You are a NEXUS agent. Work strictly inside the current working directory; refuse to access /workspace or absolute paths unless explicitly granted. Be concise.',
      });
      const ended = makeEvent('task.ended', { taskId, agentId, ok: true, summary: result?.content?.slice(0, 500) }, taskId);
      await ctx.store.append(ended);
      stdout('--- task done ---');
      stdout(result?.content ?? '(no content)');
      return 0;
    } catch (e) {
      const ended = makeEvent('task.ended', { taskId, agentId, ok: false, error: e.message }, taskId);
      try { await ctx.store.append(ended); } catch {}
      stderr('run failed:', e.message);
      return 1;
    } finally {
      await ctx.store.close();
    }
  }

  stderr('unknown command:', args.cmd, '\n', HELP);
  return 2;
}
