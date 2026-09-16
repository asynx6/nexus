#!/usr/bin/env node
// Inline runner for e2e-fib.test.js with history dump after every step.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const K = process.env.NEXUS_GATEWAY_KEY;
if (!K) { console.error('set NEXUS_GATEWAY_KEY first'); process.exit(2); }
process.env.NEXUS_GATEWAY_BASE = 'https://api.asynx6.tech/v1';
process.env.NEXUS_GATEWAY_MODELS = 'hermes-agent';

const { AgentLoop } = await import('../packages/agent-runtime/src/loop.js');
const { loopTools } = await import('../packages/agent-runtime/src/bridge.js');
const { DockerRuntime } = await import('../packages/sandbox-runtime/index.js');
const { ModelProvider } = await import('../packages/model-providers/index.js');
const { ToolRegistry, ToolExecutor, fsTools, terminalTools } = await import('../packages/tool-system/index.js');
const { PermissionManager, AuditTrail } = await import('../packages/security/index.js');
const { EventBus, EventStore } = await import('../packages/event-system/index.js');
const { newAgentId } = await import('../packages/shared/index.js');

const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
const bus = new EventBus();
const store = new EventStore(join(dir, 'events.jsonl'));
bus.on('*', (e) => store.append(e));

const agentId = newAgentId();
const runtime = new DockerRuntime();
let sandboxId = null;
try {
  await runtime.ensureImage('python:3.12-slim');
  sandboxId = await runtime.create({ image: 'python:3.12-slim', name: 'nexus-e2e-trace', network: 'none', memoryMb: 256 });
  await runtime.start(sandboxId);

  const reg = new ToolRegistry();
  for (const t of [...fsTools(), ...terminalTools()]) reg.register(t);
  const pm = new PermissionManager();
  pm.grant(agentId, 'fs.read', { paths: ['/workspace'] });
  pm.grant(agentId, 'fs.write', { paths: ['/workspace'] });
  pm.grant(agentId, 'fs.edit', { paths: ['/workspace'] });
  pm.grant(agentId, 'terminal.exec', {});
  const audit = new AuditTrail({ bus, runId: agentId });
  const executor = new ToolExecutor({ registry: reg, permissions: pm, audit });
  const provider = new ModelProvider({ baseUrl: process.env.NEXUS_GATEWAY_BASE, apiKey: K, models: ['hermes-agent'], timeoutMs: 90_000 });
  const tools = loopTools({ registry: reg, executor });

  // Patch tools.execute to snapshot messages after every step.
  const origExec = tools.execute.bind(tools);
  let stepNum = 0;
  tools.execute = async (name, args, ctx) => {
    const r = await origExec(name, args, ctx);
    stepNum++;
    return r;
  };

  const loop = new AgentLoop({ provider, tools, bus });

  // Hook: dump history via the loop's result
  const ctxBase = { agentId, runtime, sandboxId, bus };
  const result = await loop.run(
    'Create /workspace/fib.py with function fibonacci(n) iterative (fibonacci(0)=0, fibonacci(1)=1, fibonacci(10)=55). ' +
    'Then create /workspace/test_fib.py that asserts fibonacci(0)==0, fibonacci(1)==1, fibonacci(10)==55 from fib import fibonacci. ' +
    'Run it with terminal.exec command "python" args ["/workspace/test_fib.py"]. ' +
    'Finish by answering exactly: PASS (if exit code 0) or the failing output otherwise.',
    { ...ctxBase, maxSteps: 16,
      system: 'You are a coding agent inside an isolated sandbox. HARD RULES: every file path must be absolute and start with /workspace/ (writes elsewhere are denied and waste steps); create files ONLY with fs.write, run things ONLY with terminal.exec; do not explore, do not read /root, do not probe the environment. Plan in at most: write fib.py, write test_fib.py, run test, answer.' },
  );

  writeFileSync('/tmp/last-history.json', JSON.stringify({ done: result.done, steps: result.steps, answer: result.answer, history: result.history.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 400) : m.content, tool_calls: m.tool_calls?.map((tc) => ({ name: tc.function.name, args: tc.function.arguments.slice(0, 200) })) })) }, null, 2));
  console.log('done=' + result.done + ' steps=' + result.steps + ' answer=' + JSON.stringify(result.answer));
} finally {
  if (sandboxId) await runtime.stop(sandboxId).catch(() => {});
  if (sandboxId) await runtime.rm(sandboxId).catch(() => {});
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
