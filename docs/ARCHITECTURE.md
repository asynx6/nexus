# NEXUS — Architecture & Technical Decisions (lead: Asynx6)

Source of truth: `plan-nexus.md` (Beni). File ini mencatat keputusan teknis
tim. Perubahan arsitektur wajib lewat diskusi tim + update file ini via PR.

## Stack (keputusan v0.1, 2026-09-16)

| aspek | pilihan | alasan |
|---|---|---|
| Runtime | **Node.js ≥ 22, ESM, plain JS + JSDoc** | satu bahasa di seluruh tim; `node:test` builtin; JSDoc cukup buat kontrak antar-package tanpa build step; TypeScript ditunda sampai API stabil (hindari friksi 3 agen) |
| Monorepo | npm workspaces (`apps/`, `packages/`) | sesuai plan §18; satu lockfile |
| Metadata DB | **SQLite via `node:sqlite`** (builtin) | relational + migration-friendly tanpa dependensi native; interface `Storage` dibuat abstrak supaya bisa pindah Postgres di v0.5 |
| Sandbox | **Docker Engine API via HTTP ke unix socket** (tanpa SDK) | isolation nyata sesuai plan §5; SDK menambah dep; adapter `SandboxRuntime` pluggable (Docker dulu, Podman/VM kemudian) |
| HTTP API | Node `http` + router mini internal | cukup buat MVP; OpenAPI ditulis tangan di `docs/API.md`, serve JSON spec dari app |
| Event system | append-only JSONL + index SQLite | replay §12 butuh urutan; storage cheap; event bus in-process dulu, Redis pub/sub masuk saat multi-box |
| Realtime dashboard | WebSocket (RFC6455 mini impl sendiri, dep-free) | v0.2, sesuai urutan MVP |
| Model providers | adapter layer: openai-compat + anthropic-compat | §3; key hanya dari env |
| Testing | `node:test` per package + `tests/e2e` | §21; CI GitHub Actions: lint (eslint config minimal), test matrix Node 22 |

## Struktur repo

```
nexus/
├── apps/api/          # HTTP server, routes REST, bootstrap
├── apps/cli/          # `nexus` command
├── apps/dashboard/    # v0.2
├── packages/shared/   # schemas, ids, env, logging
├── packages/event-system/
├── packages/sandbox-runtime/   # SandboxRuntime iface + DockerRuntime
├── packages/tool-system/       # registry + filesystem/terminal tools
├── packages/model-providers/   # adapter iface + openai/anthropic
├── packages/agent-runtime/     # agent loop (§4)
├── packages/memory/            # v0.3
├── packages/security/          # permissions + audit
├── docs/              # ARCHITECTURE.md, API.md, SECURITY.md, plan-nexus.md
├── infra/             # docker/ sandbox images
└── tests/e2e/
```

## Aturan tim (dari Beni, diikat di sini)
- Asynx6 = lead, reviewer, **satu-satunya merger** ke `main`
- Leonars/Leo → branch sendiri → **PR** → review → test verify → merge
- Fitur dianggap selesai setelah TEST dengan bukti, bukan "berjalan sekali"
- Perubahan berdampak → koordinasi dulu (link/GitHub issue), jangan sepihak
- Zero-bug mindset: bug ditemukan = perbaiki sekarang sesuai dampak
- GitHub transparan untuk semua aktivitas

## Kontrak antar-package (penting: biar 3 agen gak tabrakan)
1. `packages/shared` = SATU-SATUNYA sumber tipe/skema/konstanta bersama.
   Semua paket lain hanya boleh import ke dalam, tidak sebaliknya.
2. Event name & payload = `event-system` yang define; consumers baca dari sana.
3. `SandboxRuntime.exec()` menghasilkan `tool_result` event — interface di
   `shared` dulu, implementasi belakangan.
4. Public API tiap package = satu file `index.js` (facade), internal bebas
   dirombak tanpa mengganggu paket lain.
