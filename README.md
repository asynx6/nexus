# NEXUS

Open-source AI Agent Operating Environment. Agents run tasks in isolated Docker sandboxes, write code, execute terminal commands, fix their own errors, and persist every step as a replayable event log.

## What it is

NEXUS gives an LLM agent:

- An **isolated Docker sandbox** with filesystem and terminal access, deny-by-default network and resource limits.
- **Pluggable tools** (filesystem, terminal, network) gated by a permission manager and audit trail.
- An **append-only event log** of every tool call, decision, and result, replayable from any point.
- **Long-term memory** (short-term, long-term, project) with both pluggable storage and an event-stream recall index.
- A **CLI operator** (`nexus run`, `nexus replay`, `nexus tasks`, `nexus healthz`, `nexus init`) to drive agents from the terminal.
- A **minimal web dashboard** for live event streams, replay, and run-to-run diff.
- A **Model Context Protocol (MCP) server** so Claude Code, Cursor, and other MCP-aware clients can use NEXUS as a tool source.
- **Multi-model consensus** — N agents vote on tool calls; automatic fallback when a primary model errors out.
- **Multi-agent supervision** and **per-project knowledge-graph memory** (in v0.3.0).

Everything runs on Node 22 with `node:sqlite`. Zero external runtime dependencies. Any OpenAI-compatible chat-completions endpoint works as the model backend.

## Why

Most "agent" stacks are wrappers around a chat loop. NEXUS is built around the audit trail. Every action the agent takes is an event; every event has a sequence number, a timestamp, a subject, and structured data. That gives you:

- Replay any run from any point to reproduce or diagnose failures.
- Reconcile tool calls against the model output to detect drift.
- **Diff two runs** event-by-event to see exactly why a retry, a regression, or a flaky task diverged.
- Audit which agent touched which file under which grant.
- Share an event stream across multiple agents without coupling their runtimes.

## Architecture

```
nexus/
├── packages/
│   ├── shared/           # event contracts, id gen, env loader, logger
│   ├── event-system/     # EventBus + JSONL store + sqlite index + replay
│   ├── sandbox-runtime/  # Docker engine API, network + resource limits
│   ├── security/         # PermissionManager + AuditTrail + SecretStore
│   ├── tool-system/      # ToolRegistry + ToolExecutor + fs/terminal tools
│   ├── model-providers/  # OpenAI-compatible client, native tool calling
│   ├── agent-runtime/    # AgentLoop, verdict shortcut, tool bridge
│   └── memory/           # MemoryManager (pluggable) + EventRecall (sqlite)
├── apps/
│   ├── cli/              # nexus CLI: run / replay --follow / tasks / healthz
│   └── web/              # minimal dashboard (live events + replay)
└── docs/
    ├── plan-nexus.md     # source of truth
    ├── ARCHITECTURE.md   # design decisions
    └── TASKS.md          # MVP board
```

The split is enforced by `package.json` workspaces and `docs/ARCHITECTURE.md` rules. The `index.js` of every package re-exports the public surface; concrete storage backends and HTTP clients live in `src/` so they can be swapped without touching callers.

## Install

Requirements:

- Node **≥ 22** (for `node:sqlite` and the test runner)
- Docker (only required if you run the e2e fibonacci gate; the unit suites run without it)
- An OpenAI-compatible chat-completions endpoint with a model that supports tool calling

```sh
git clone https://github.com/asynx6/nexus-cli
cd nexus
npm install
cp .env.example .env  # then edit
```

## Configure

`.env` (gitignored):

```
NEXUS_GATEWAY_BASE=https://api.asynx6.tech/v1   # any OpenAI-compatible base URL
NEXUS_GATEWAY_KEY=sk-...                        # your API key
NEXUS_GATEWAY_MODELS=hermes-agent,im/auto       # comma-separated fallback chain
```

The first model in `NEXUS_GATEWAY_MODELS` is the default. The provider tries each in order on 401/404/timeout, so put your cheapest reliable model first.

## Run

```sh
npm test                       # full suite, ~7s
npm test -w @nexus/event-system
node apps/cli/bin.mjs healthz  # verify gateway reachable
node apps/cli/bin.mjs run "write a fibonacci function in /workspace/fib.py"
node apps/cli/bin.mjs replay --follow
```

`nexus run` creates a sandbox, mounts the working directory at `/workspace`, grants the CLI agent read/write/edit there plus unrestricted `terminal.exec`, and streams every step to the event store. `nexus replay --follow` tails that store in real time.

## Web dashboard

```sh
cd apps/web
node index.js
# open http://localhost:3000
```

The dashboard shows live events from any active run, the per-run event count, and a replay view that lets you scrub through past runs.

## Webhooks

Subscribe any HTTP endpoint to the event stream. Every matching event is POSTed as JSON, HMAC-SHA256 signed in the `X-NEXUS-Signature` header (`sha256=<hex>`), with exponential-backoff retries that stop on permanent errors (4xx) and keep going on transient ones (5xx, 429, network).

```sh
export NEXUS_API_BASE=http://localhost:4000   # control plane base url
export NEXUS_API_TOKEN=...                    # bearer token (if the plane requires auth)

nexus webhooks add https://your-service/hooks/nexus --events=task.completed,task.failed --secret=wh-secret
nexus webhooks list
nexus webhooks test hook-<id>                 # emit a synthetic webhook.test event
nexus webhooks pause hook-<id>                # stop delivery without deleting the registration
```

Verify the signature on the receiving side (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const raw = await req.text();                                 // exact bytes
const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
if (!timingSafeEqual(Buffer.from(req.headers['x-nexus-signature']), Buffer.from(sig))) return 401;
```

The secret is stored in memory only and is never echoed back by the API; `hasSecret` in the registration record tells you a signature header to expect. Delivery is fire-and-forget from the event bus, so a slow receiver never blocks the agent loop.

## Versioned system prompts

System prompts are named and versioned, so a recorded run can be replayed against the exact instruction bytes it used:

```
nexus prompts list                             # names + active version + version counts
nexus prompts show cli.default                 # body of the active version
nexus prompts show cli.default --rev=<hash>    # body of one version
nexus prompts diff cli.default <left> <right>  # added/removed lines
nexus prompts rollback cli.default <hash>      # re-pin an older version as active
nexus prompts edit cli.default                 # open $EDITOR, publish on save
```

A run pins its prompt so the resolved hash rides on the `task.started` event:

```
nexus run "write fib" --prompt=cli.default                 # latest version
nexus run "write fib" --prompt=cli.default@<hash>          # that exact version
```

## Project secrets

Per-project secrets (API keys, tokens) live in an encrypted vault at `.nexus/secrets.enc`, not in `.env` or the repo. Values are decrypted into the agent's exec environment only — never written to disk, logs, or events.

```sh
nexus secrets init                             # create the vault (asks for a passphrase)
export NEXUS_PROJECT_PASSPHRASE=...            # or prompt each run
nexus secrets set OPENAI_API_KEY               # add a secret (value prompted, not echoed)
nexus secrets list                             # names only — values never printed
nexus secrets grant agent-1 OPENAI_API_KEY     # let an agent read it into its exec env
nexus secrets revoke agent-1 OPENAI_API_KEY
```

At rest the vault is AES-256-GCM with a key derived per project (scrypt over your passphrase with a random salt), so the same passphrase yields different ciphertext in two projects and a stolen vault file is worthless without the passphrase. Which principal may read which name is a separate grant table — deny-by-default, and every grant, revoke, and access is emitted as an audit event.

## Contributing

1. Fork and branch from `main`. Branch name: `feat/<scope>` or `fix/<scope>`.
2. Read `docs/plan-nexus.md` and `docs/ARCHITECTURE.md` first. The architecture rules are not optional.
3. Write a failing test before the fix. Run `npm test` until green.
4. Open a PR against `asynx6/nexus-cli:main`. The PR description must cite the relevant task in `docs/TASKS.md`.
5. Only `asynx6` merges to `main`. Expect a review pass; expect to be asked to tighten something.

Code conventions:

- ESM only, no TypeScript.
- Zero external runtime dependencies. If you need a feature, check Node stdlib first.
- `node:test` for tests. No Jest, no Vitest, no Mocha.
- One public surface per package (`index.js`). Implementation files live in `src/`.

## Status

Current release is **v0.2.0** (Brainstorm Sprint): adds MCP server, multi-model consensus, replay UI, and `nexus init` wizard.

In flight for **v0.3.0** (Autonomy Sprint, 2026-09-18+):

| Milestone | Theme | Examples |
|-----------|-------|----------|
| A | AI-native power | multi-agent supervisor, knowledge-graph memory, tool auto-discovery, prompt versioning |
| B | Observability | live web dashboard, replay diff between two runs ✅ |
| C | Developer experience | `nexus doctor --fix`, `nexus ask` inline playground |
| D | Integrations + DB | GitHub Actions bot, webhook receiver, pluggable DB (SQLite default + PG/MySQL/Mongo), one-click deploy |
| E | Security + governance | per-project encrypted secrets, immutable hash-chained audit, rate limiting, sandbox policy DSL |
| F | Multi-modal | image, audio, file uploads, screenshot tool |
| G | Scale + reliability | cluster mode, event snapshot, graceful shutdown, k8s health probes |
| H | Monetization-ready | license server, opt-in telemetry, plugin marketplace, hosted NEXUS |

See `docs/TASKS.md` for the live board and `docs/plan-nexus.md` for the full roadmap. Track milestone progress at https://github.com/asynx6/nexus-cli/milestone/1.

## License

MIT.
