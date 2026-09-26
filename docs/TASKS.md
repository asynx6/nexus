# NEXUS — Task Breakdown MVP v0.1

Status board (updated lead 2026-09-16): ✅ merged | 🔨 in progress | ⏭️ next

| Task | Owner | Status |
|---|---|---|
| P00 monorepo scaffolding + CI | Asynx6 | ✅ d1e7d94 |
| P01 shared contracts | Asynx6 | ✅ 3b109d7 (#3) |
| P02 event-system | Leonars | ✅ 0f75ef8 (#5) |
| P03 sandbox-runtime | Leo | ✅ c556831 (#4) |
| P04 security | Leonars | ✅ 0ec2f8f (#6) + hotfix #7 |
| P05 tool-system | Leo | ✅ merged (#10) + bridge loopTools (#12) |
| P06 model-providers | Asynx6 | ✅ d5deb5a (#8) native function-calling + SSE-tolerance |
| P07 agent-loop | Asynx6 | ✅ 8f03544 (#9) + ctx-forwarding (#14) |
| P08 control-plane api/cli | Leonars | 🔨 #15 closed, branch feat/p08-control-plane — pending rebase P09/P11 first |
| P09 e2e fibonacci gate | Leo (harness: Asynx6) | ✅ 331883f (#21 merged) — verdict shortcut PASS/FAIL alongside tool_call |
| P10 CLI operator `nexus` | Asynx6 (self) | ✅ 78879c4 (run/replay/tasks/healthz), +79708f6 (--follow) |
| P11 web dashboard minimal | Leo | ✅ 748a746 (#23 merged) — apps/web + closes #18 |
| P12 memory package | Kevin+Vinz | ✅ b63adb5 (#20) — Kevin's MemoryManager (pluggable) + VinZ's EventRecall (sqlite) |
| P13 multi-agent coordination | Kevin (asynx3) | ✅ 5d02eb2 (#24 merged) — per-agent EventStore streams + handshake + cross-agent messaging |
| P16 replay UI (`nexus replay --port`) | Kevin (asynx3) | 🔨 feat/p16-replay-ui — replay-server.js + public/ (vanilla timeline + SSE follow + filter), 4 new tests pass |

Cross-test: 141 tests, 124 pass, 0 fail, 17 skipped (sandbox+gateway stubs). PR merged: #3,#4,#5,#6,#7,#8,#9,#10,#11,#12,#13,#14,#20,#21,#23,#24. Closed without merge: #15 (Leonars PR superseded), #22 (Kevin P11 → Leo #23 picked). HEAD: 5d02eb2. Release: v0.1.0. Branches: 1 remote (main), 0 PR open.

Pemecahan plan-nexus.md jadi task realistis. Dependency didahulukan.
Format: `[Pxx] task — owner | butuh: | definisi selesai (test!)`

## WAVE 0 — fondasi (Asynx6, harus duluan, semua orang nunggu ini)
- [P00] Scaffolding monorepo: workspaces, 12 package kosong dgn index.js + package.json, tsconfig/jsdoc lint config, CI workflow (node 22, npm workspaces test), .gitignore, LICENSE, README — **Asynx6** | butuh: repo created, akses Asynx4/Asynx5 diinvite | selesai: `npm test` hijau (meski isinya placeholder tests), CI green di GitHub
- [P01] packages/shared: event schema + nama event (plan §11), ids, env loader, konstanta, logger — **Asynx6** | selesai: unit test serialisasi event lengkap

## WAVE 1 — core (paralel, setelah P00+P01 di-merge)
- [P02] packages/event-system: EventBus (in-proc), EventStore append-only JSONL + index SQLite (node:sqlite), replay iterator (urutan ts) — **Leonars** | selesai: test write→drain→replay deterministik, 1000 events < 200ms
- [P03] packages/sandbox-runtime: iface SandboxRuntime + DockerRuntime via HTTP-over-unix-socket (create/start/exec/copy/stop/rm), resource limits (cpu, mem, pids, disk opts), network policy (bridge/none), timeout keras — **Leo** (box-nya punya Docker, paling kuat) | selesai: integration test di Linux: exec `echo`, `python -c`, resource limit dibuktikan kena (mem-limit test), cleanup yatim
- [P04] packages/security: PermissionManager (allowlist tool per agent), audit event tiap keputusan, secret isolation (env injection saat exec saja, gak ke-disk) — **Leonars** | selesai: test deny-by-default, audit trail cocok
- [P05] packages/tool-system: ToolRegistry (name/desc/schema/perm/timeout/handler), tools filesystem.read/write/edit + terminal.exec — semua lewat SandboxRuntime + PermissionManager + emit events — **Leo** | selesai: unit + integration, tool tanpa izin ditolak dgn event reason
- [P06] packages/model-providers: adapter iface (chat/stream/tool_call/metadata) + openai-compat + anthropic-compat, structured tool calling dua2nya — **Asynx6** | selesai: mock-server tests kedua gaya API (no network)
- [P07] packages/agent-runtime: agent loop OBSERVE→PLAN→TOOL→EXECUTE→MEMORY(short)→CONTINUE (plan §4), max-turns, error→retry policy — **Asynx6** | selesai: loop test dgn provider stub: task "fibonacci" menghasilkan urutan tool call yang benar

## WAVE 2 — integrasi MVP
- [P08] apps/api + apps/cli: REST minimal (§15 subset) + `nexus agent/sandbox/task` commands; bootstrap wiring P02-P07 — **Leonars** (api) / **Leo** (cli) | selesai: CLI bikin agent, kasih task fibonacci, agent beneran bikin file + jalanin python di Docker, events keliatan, result keluar
- [P09] e2e demo test (§26 FIRST OBJECTIVE): "create python fibonacci, run, test, return result" dari command satu baris — **Leo** | selesai: test di CI Linux (Docker service enabled) — INI GATE MVP

## ATURAN MAIN
- Task = satu branch PR, judul `Pxx: ...`, description: apa + bukti test
- Saling tergantung? Koordinasi via link/GitHub issue, JANGAN nunggu diem
- Review: gw merge setelah test gw verify sendiri di box gw (non-sandbox parts) ATAU bukti test Leo masuk di PR
- Bug ketemu di bagian orang: report + reproduksi, jangan diam-diam rewrite
- Definition of Done = §21 plan: bukan "jalan sekali"

---

## WAVE 3 — v0.3.0 finalization (2026-09-25+, crew: Vinz + Leonars only)

| Task | Owner | Status |
|---|---|---|
| B3 replay diff between two runs | Leonars | ✅ feat/B3-replay-diff — `nexus replay diff <left> <right>` + /api/diff + /api/subjects + browser diff view |
| D2 webhook receiver | Leonars | ✅ feat/D2-webhooks — registry + delivery engine + `nexus webhooks` CLI + REST CRUD |
| E1 per-project encrypted secrets | Leonars | 🔨 feat/E1-project-secrets — Vault (scrypt+aes-256-gcm) + ProjectSecrets RBAC + `nexus secrets` CLI |
| A3 tool auto-discovery | Leonars | ✅ 409708e — *.tools.js + @nexus/tool-* auto-load (ctx.js) |
| A4 prompt versioning | Leonars | ⏭️ queued |
| A1 multi-agent supervisor | Leonars | ⏭️ last, before feature freeze |

Finalization rule (Bos, 2026-09-25): clear the smaller tasks first; A1 is the
last item before the final release tag. Self-merge is allowed per standing
rule. Leo and Kevin are permanently off the team — do not assign them.
