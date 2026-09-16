# NEXUS

Open-source AI Agent Operating Environment — autonomous agents bekerja di sandbox terisolasi dengan filesystem, terminal, memory, events, replay, dan multi-agent collaboration.

Bukan chatbot wrapper: agent terima task, bikin sandbox, tulis kode, jalankan terminal, perbaiki errornya sendiri, dan semua langkah tercatat sebagai event yang bisa di-replay.

- Source of truth: [docs/plan-nexus.md](docs/plan-nexus.md)
- Arsitektur & keputusan tim: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Task board MVP: [docs/TASKS.md](docs/TASKS.md)

## Status MVP v0.1

| Komponen | Isi |
|---|---|
| `packages/shared` | kontrak event + id + env + logger |
| `packages/event-system` | EventBus + JSONL store + index SQLite + replay |
| `packages/sandbox-runtime` | DockerEngine API via unix socket, network deny-by-default, resource limits |
| `packages/security` | PermissionManager deny-by-default, AuditTrail, SecretStore (in-memory) |
| `packages/tool-system` | ToolRegistry + fs.read/write/edit + terminal.exec, satu funnel validasi→izin→audit→event |
| `packages/model-providers` | klien OpenAI-compatible, fallback antar model, native function-calling |
| `packages/agent-runtime` | AgentLoop (task→tools→answer) + bridge ke tool-system |

Belum: control-plane API + CLI (P08), memory/replay UI, browser tool, multi-agent — lihat board.

## Dev

Node ≥ 22 (butuh `node:sqlite`). Zero dependency eksternal — cuma Node builtins + npm workspaces.

```
npm install
npm test
```

Set gateway LLM di `.env`: `NEXUS_GATEWAY_BASE`, `NEXUS_GATEWAY_KEY`, `NEXUS_GATEWAY_MODELS` (comma, urut = prioritas fallback).

## Tim

Asynx6 (lead/reviewer/merger) · Leonars/Asynx4 (dev) · Leo/Asynx5 (dev+tester). Semua perubahan lewat branch + PR.

MIT
