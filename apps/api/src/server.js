// Bootstrap the control plane: wire EventBus + EventStore + SecretStore +
// PermissionManager + AuditTrail + SandboxRuntime + ToolRegistry/Executor +
// ModelProvider, mount the router, expose start/stop.
//
// Env contract:
//   NEXUS_API_PORT        bind port (default 4000)
//   NEXUS_DATA_DIR        root for EventStore JSONL (default .nexus-data)
//   NEXUS_API_TOKEN       if set, store as 'NEXUS_API_TOKEN' in SecretStore
//   NEXUS_GATEWAY_BASE    base URL of the LLM gateway (required for /tasks)
//   NEXUS_GATEWAY_KEY     value stored as 'NEXUS_GATEWAY_KEY' in SecretStore
//   NEXUS_GATEWAY_MODELS  comma list, first is primary
//   NEXUS_GATEWAY_KEY_NAME  override secret name (default 'NEXUS_GATEWAY_KEY')

import { createServer } from 'node:http';
import { EventBus, EventStore } from '@nexus/event-system';
import { PermissionManager, AuditTrail, SecretStore } from '@nexus/security';
import { ToolRegistry, ToolExecutor, fsTools, terminalTools } from '@nexus/tool-system';
import { DockerRuntime } from '@nexus/sandbox-runtime';
import { ModelProvider } from '@nexus/model-providers';
import { AgentLoop, loopTools } from '@nexus/agent-runtime';
import { loadEnv, makeLogger } from '@nexus/shared';
import { TaskStore } from './state.js';
import { createRouter, sendJson } from './router.js';
import { bearerAuth, compose } from './auth.js';
import { makeHandlers } from './handlers.js';

// expose ModelProvider + AgentLoop on globalThis so handlers.js can avoid a
// hard dep edge — the api facade depends on both packages already; we just
// keep the import surface in one place.
globalThis.__nexus_model_providers__ = { ModelProvider };
globalThis.__nexus_agent_runtime__ = { AgentLoop, loopTools };

/**
 * Build the wired app (no listening yet).
 * @param {{ envPath?: string, logger?, runtime?: any }} [opts]
 */
export async function buildApp(opts = {}) {
  if (opts.envPath !== undefined) loadEnv(opts.envPath);

  const logger = opts.logger ?? makeLogger('api', { json: process.env.NEXUS_LOG_JSON === '1' });
  const dataDir = process.env.NEXUS_DATA_DIR || '.nexus-data';
  const eventStore = new EventStore(dataDir + '/events.jsonl');
  const bus = new EventBus();

  // bus -> store funnel: every emitted event lands in the JSONL file.
  bus.on('*', (ev) => { try { eventStore.append(ev); } catch { /* never let observability kill the caller */ } });

  const secrets = new SecretStore();
  if (process.env.NEXUS_API_TOKEN) secrets.set('NEXUS_API_TOKEN', process.env.NEXUS_API_TOKEN);
  if (process.env.NEXUS_GATEWAY_KEY) secrets.set(process.env.NEXUS_GATEWAY_KEY_NAME || 'NEXUS_GATEWAY_KEY', process.env.NEXUS_GATEWAY_KEY);

  const permissions = new PermissionManager();
  const registry = new ToolRegistry();
  for (const t of [...fsTools(), ...terminalTools()]) registry.register(t);
  const audit = new AuditTrail({ bus, runId: 'api' });
  const runtime = opts.runtime ?? null; // caller provides a fake in tests
  if (!runtime) throw new Error('runtime required (pass opts.runtime; production: new DockerRuntime())');

  const executor = new ToolExecutor({ registry, permissions, audit });

  const taskStore = new TaskStore();
  const handlers = makeHandlers({
    store: taskStore, bus, eventStore, secrets, permissions,
    runtime, registry, executor, audit, logger,
  });

  const authMw = bearerAuth({ secrets });
  const routes = [
    { method: 'GET', pattern: '/healthz', handler: (ctx) => { authMw(ctx.req, ctx.res, () => handlers.healthz(ctx)); } },
    { method: 'GET', pattern: '/tasks', handler: (ctx) => { authMw(ctx.req, ctx.res, () => handlers.listTasks(ctx)); } },
    { method: 'POST', pattern: '/tasks', handler: (ctx) => { authMw(ctx.req, ctx.res, () => handlers.createTask(ctx)); } },
    { method: 'GET', pattern: '/tasks/:id', handler: (ctx) => { authMw(ctx.req, ctx.res, () => handlers.getTask(ctx)); } },
    { method: 'GET', pattern: '/tasks/:id/events', handler: (ctx) => { authMw(ctx.req, ctx.res, () => handlers.streamTaskEvents(ctx)); } },
  ];
  const dispatch = createRouter(routes, { notFound: (res) => sendJson(res, 404, { error: 'not_found' }) });

  return { logger, bus, eventStore, secrets, permissions, registry, executor, runtime, taskStore, handlers, dispatch };
}

/**
 * Start an HTTP server around the wired app.
 * @param {object} app
 * @param {{ port?: number, host?: string }} [opts]
 */
export function serve(app, opts = {}) {
  const port = opts.port ?? (Number(process.env.NEXUS_API_PORT) || 4000);
  const host = opts.host ?? (process.env.NEXUS_API_HOST || '127.0.0.1');
  const server = createServer(app.dispatch);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      app.logger.info('api listening', { host, port: addr.port });
      resolve({ server, port: addr.port, host });
    });
  });
}

/** Close the HTTP server + drain in-flight task runs + close the EventStore. */
export async function closeApp(app, http) {
  if (http?.server) await new Promise((r) => http.server.close(() => r()));
  await app.taskStore.drain();
  app.eventStore.close();
}
