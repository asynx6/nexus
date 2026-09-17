# NEXUS

Open-source AI Agent Operating Environment. Agen jalankan task di sandbox Docker terisolasi, nulis kode, eksekusi perintah terminal, perbaiki error sendiri, dan setiap langkah tercatat jadi event log yang bisa di-replay.

## Apa ini

NEXUS kasih agent LLM:

- **Docker sandbox terisolasi** dengan akses filesystem + terminal, network deny-by-default, limit resource.
- **Tool pluggable** (filesystem, terminal, network) lewat permission manager + audit trail.
- **Event log append-only** buat setiap tool call, keputusan, hasil. Bisa di-replay dari titik manapun.
- **Memori jangka panjang** (short-term, long-term, project) dengan storage pluggable + index recall event stream.
- **CLI operator** (`nexus run`, `nexus replay`, `nexus tasks`, `nexus healthz`) buat kendaliin agen dari terminal.
- **Web dashboard minimal** buat live event stream + replay.

Semuanya jalan di Node 22 dengan `node:sqlite`. Nol dependency eksternal saat runtime. Endpoint chat-completions apa aja yang OpenAI-compatible bisa jadi model backend.

## Kenapa

Kebanyakan stack "agent" cuma wrapper di chat loop. NEXUS dibangun di atas audit trail. Setiap aksi agent = satu event. Setiap event punya sequence number, timestamp, subject, data terstruktur. Hasilnya:

- Replay run manapun dari titik manapun buat reproduksi atau diagnosis.
- Audit tool call vs output model buat deteksi drift.
- Lacak agent mana nyentuh file mana lewat grant mana.
- Share event stream antar agent tanpa coupling runtime-nya.

## Arsitektur

```
nexus/
├── packages/
│   ├── shared/           # kontrak event, id gen, env loader, logger
│   ├── event-system/     # EventBus + JSONL store + sqlite index + replay
│   ├── sandbox-runtime/  # Docker engine API, limit network + resource
│   ├── security/         # PermissionManager + AuditTrail + SecretStore
│   ├── tool-system/      # ToolRegistry + ToolExecutor + fs/terminal tools
│   ├── model-providers/  # klien OpenAI-compatible, native tool calling
│   ├── agent-runtime/    # AgentLoop, verdict shortcut, tool bridge
│   └── memory/           # MemoryManager (pluggable) + EventRecall (sqlite)
├── apps/
│   ├── cli/              # CLI nexus: run / replay --follow / tasks / healthz
│   └── web/              # dashboard minimal (live events + replay)
└── docs/
    ├── plan-nexus.md     # source of truth
    ├── ARCHITECTURE.md   # keputusan desain
    └── TASKS.md          # papan MVP
```

Split ini dijaga lewat `package.json` workspaces + aturan di `docs/ARCHITECTURE.md`. `index.js` tiap package cuma re-export public surface; storage backend konkret + HTTP client ada di `src/` biar bisa di-swap tanpa nyentuh caller.

## Install

Butuh:

- Node **≥ 22** (untuk `node:sqlite` + test runner)
- Docker (cuma kalau mau jalanin e2e fibonacci gate; unit suite jalan tanpa Docker)
- Endpoint chat-completions OpenAI-compatible dengan model yang support tool calling

```sh
git clone https://github.com/asynx6/nexus
cd nexus
npm install
cp .env.example .env  # lalu edit
```

## Konfigurasi

`.env` (di-gitignore):

```
NEXUS_GATEWAY_BASE=https://api.asynx6.tech/v1   # base URL OpenAI-compatible apapun
NEXUS_GATEWAY_KEY=sk-...                        # API key lo
NEXUS_GATEWAY_MODELS=hermes-agent,im/auto       # fallback chain, pisah koma
```

Model pertama di `NEXUS_GATEWAY_MODELS` = default. Provider coba satu-satu kalau 401/404/timeout, jadi taruh model paling murah + paling reliable di depan.

## Jalankan

```sh
npm test                          # full suite, ~7 detik
npm test -w @nexus/event-system
node apps/cli/bin.mjs healthz     # cek gateway hidup
node apps/cli/bin.mjs run "tulis fungsi fibonacci di /workspace/fib.py"
node apps/cli/bin.mjs replay --follow
```

`nexus run` bikin sandbox, mount working directory di `/workspace`, kasih CLI agent akses read/write/edit di situ + `terminal.exec` unrestricted, terus stream setiap langkah ke event store. `nexus replay --follow` tail store itu real-time.

## Web dashboard

```sh
cd apps/web
node index.js
# buka http://localhost:3000
```

Dashboard nampilin event live dari run aktif, jumlah event per run, dan replay view buat scrub ke run lampau.

## Kontribusi

1. Fork + branch dari `main`. Nama branch: `feat/<scope>` atau `fix/<scope>`.
2. Baca `docs/plan-nexus.md` + `docs/ARCHITECTURE.md` dulu. Aturan arsitektur wajib, bukan opsional.
3. Tulis test yang fail dulu, baru fix. `npm test` sampai ijo.
4. Buka PR ke `asynx6/nexus:main`. Deskripsi PR harus nyebut task relevan di `docs/TASKS.md`.
5. Cuma `asynx6` yang boleh merge ke `main`. Expect review; expect diminta tighter lagi.

Konvensi kode:

- ESM only, no TypeScript.
- Nol dependency runtime eksternal. Kalau butuh fitur, cek Node stdlib dulu.
- `node:test` buat test. No Jest, no Vitest, no Mocha.
- Satu public surface per package (`index.js`). File implementasi di `src/`.

## Status

Aktif dikembangkan. MVP saat ini **v0.1.0**: event-system, sandbox, security, tools, providers, agent loop, memory, CLI, dan web dashboard full. Multi-agent coordination sedang jalan.

Lihat `docs/TASKS.md` buat papan live + `docs/plan-nexus.md` buat roadmap lengkap.

## Lisensi

MIT.
