// ../vendor/cli/index.js ctx builder — wire shared+events+tools+security+provider+loop
// Keeps imports DOWN-only (no other package imports ../vendor/cli/index.js).
// Zero external deps. Node ≥22 ESM.

import { loadEnv, makeLogger } from '@nexus/shared';
import { EventBus, EventStore, makeEvent } from '@nexus/event-system';
import { ModelProvider } from '@nexus/model-providers';
import { ToolRegistry, ToolExecutor, fsTools, terminalTools, autoDiscoverTools } from '@nexus/tool-system';
import { PermissionManager, AuditTrail, Vault, ProjectSecrets } from '@nexus/security';
import { loadPromptStore } from './prompts.js';
import { AgentLoop, loopTools } from '@nexus/agent-runtime';
import { loadPlugins } from '@nexus/plugin-registry';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export { AgentLoop };

/** Build a reusable run context: provider + tools + loop + event bus + store.
 *  Env-driven config (NEXUS_GATEWAY_*) — no secrets in code. */
export async function buildRunCtx(opts = {}) {
  // loadEnv populates process.env without leaking values; read them back.
  // Gateway secrets live in .env-gateway (setup wizard target), not .env.
  loadEnv('.env-gateway');
  const env = opts.env ?? process.env;
  const log = opts.log ?? makeLogger('cli');

  const bus = new EventBus();
  const store = new StoreHandle(opts.storeDir ?? './.nexus/store');
  const audit = new AuditTrail({ bus, runId: opts.runId ?? 'cli' });

  const baseUrl = opts.baseUrl ?? env.NEXUS_GATEWAY_BASE ?? 'https://api.asynx6.tech/v1';
  const apiKey = opts.apiKey ?? env.NEXUS_GATEWAY_KEY;
  if (!apiKey) throw new Error('NEXUS_GATEWAY_KEY required (env or opts)');
  const models = (opts.models ?? env.NEXUS_GATEWAY_MODELS ?? 'hermes-agent')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const provider = new ModelProvider({
    baseUrl, apiKey, models, timeoutMs: opts.timeoutMs ?? 120_000,
    rateLimit: opts.rateLimit ?? (env.NEXUS_RATE_LIMIT_RPM
      ? { rpm: Number(env.NEXUS_RATE_LIMIT_RPM), burst: Number(env.NEXUS_RATE_LIMIT_BURST ?? env.NEXUS_RATE_LIMIT_RPM) }
      : null)
  });
  const registry = new ToolRegistry();
  for (const t of fsTools({ allowedPaths: ['/workspace', process.cwd()] })) registry.register(t);
  for (const t of terminalTools({ timeoutMs: 60_000 })) registry.register(t);
  const pluginErrors = [];
  if (env.NEXUS_ENABLE_PLUGINS !== '0') {
    const pluginDirs = [join(process.cwd(), '.nexus', 'plugins')];
    if (env.NEXUS_PLUGIN_DIR) pluginDirs.push(env.NEXUS_PLUGIN_DIR);
    const { plugins, errors } = await loadPlugins(pluginDirs);
    for (const pl of plugins) {
      for (const t of pl.tools) {
        if (!registry.has(t.name)) registry.register(t);
      }
    }
    pluginErrors.push(...errors);
    if (errors.length && log) log.warn(`plugins: ${errors.length} failed to load`);
  }
  // A3 auto-discovery: *.tools.js under .nexus/tools + @nexus/tool-* deps.
  // Runs after plugins, so an explicit project tool always wins a name clash.
  const auto = await autoDiscoverTools(registry, { cwd: process.cwd() });
  pluginErrors.push(...auto.errors.map((e) => ({ path: e.source, error: e.error })));
  if (auto.errors.length && log) log.warn(`tool discovery: ${auto.errors.length} source(s) failed`);
  const allowedPaths = ['/workspace', process.cwd()];
  const allowedPathPatterns = allowedPaths.flatMap((p) => [p, `${p}/**`]);
  const permissions = new PermissionManager();
  permissions.grant('cli', 'fs.read', { paths: allowedPathPatterns });
  permissions.grant('cli', 'fs.write', { paths: allowedPathPatterns });
  permissions.grant('cli', 'fs.edit', { paths: allowedPathPatterns });
  permissions.grant('cli', 'terminal.exec', {});

  const executor = new ToolExecutor({ registry, permissions, audit });
  const tools = loopTools({ registry, executor });

  // E1: decrypt the per-project vault and materialize granted secrets into the
  // exec env. With no vault configured this is a no-op — P04 behavior unchanged.
  let projectSecrets = null;
  let secretNames = [];
  const pass = opts.passphrase ?? env.NEXUS_PROJECT_PASSPHRASE;
  const vaultPath = opts.vaultPath ?? env.NEXUS_PROJECT_SECRETS_FILE ?? join(process.cwd(), '.nexus', 'secrets.enc');
  if (pass && existsSync(vaultPath)) {
    const vault = Vault.open(pass, readFileSync(vaultPath, 'utf8'));
    projectSecrets = new ProjectSecrets({ vault, bus });
    loadGrantsSidecar(projectSecrets, vaultPath);
    // 'cli' is the principal for a local run; agent ids get grants via the API.
    secretNames = projectSecrets.grantsFor('cli');
    for (const name of secretNames) {
      const plaintext = vault.get(name);
      if (plaintext !== null) env[name] = plaintext;
    }
    if (secretNames.length && log) log.info(`secrets: ${secretNames.length} injected from project vault`);
  }

  // A4: named, versioned system prompts. Load the persisted store (this is the
  // same file `nexus prompts edit` writes) and seed built-ins on top, so a run
  // sees published versions and `--prompt=name@hash` resolves to real bytes.
  const prompts = loadPromptStore(env).registry;

  return { log, bus, store, audit, provider, registry, permissions, executor, tools, env, pluginErrors,
    projectSecrets, secretNames, prompts };
}

/** Grants live in <vault>.grants (names only — never values). */
function loadGrantsSidecar(secrets, vaultPath) {
  const p = vaultPath + '.grants';
  if (!existsSync(p)) return;
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  for (const [principal, names] of Object.entries(doc)) {
    for (const name of names) secrets.grant(principal, name);
  }
}

/** Build a replay context: only event store + bus (read-only). */
export function buildReplayCtx(opts = {}) {
  const store = new StoreHandle(opts.storeDir ?? './.nexus/store');
  const bus = new EventBus();
  return { bus, store };
}

/** Lazy wrapper that opens EventStore on first access and keeps path. */
class StoreHandle {
  constructor(dir) {
    this.dir = dir;
    this._store = null;
  }
  async open() {
    if (!this._store) this._store = new EventStore(this.dir + '/events.jsonl');
    return this._store;
  }
  async append(env) { return this.open().then((s) => s.append(env)); }
  async replay(opts) { return this.open().then((s) => s.replay(opts)); }
  async close() { if (this._store) await this._store.close(); }
}
