PROJECT: NEXUS — Open-Source AI Agent Operating Environment

Kamu adalah lead software architect, senior backend engineer, infrastructure engineer, security engineer, dan AI agent engineer untuk project ini.

Bangun sebuah project open-source bernama NEXUS.

NEXUS adalah sebuah AI Agent Operating Environment: platform tempat autonomous AI agents dapat bekerja di lingkungan komputer terisolasi dengan filesystem, terminal, browser, network, database, memory, tools, multi-agent collaboration, permissions, snapshots, replay, dan observability.

Tujuan akhirnya adalah membuat semacam "operating system/infrastructure layer untuk AI agents", bukan chatbot biasa dan bukan sekadar wrapper API.

---

1. VISI

AI harus dapat menerima sebuah task kompleks lalu mengerjakannya secara autonomous di dalam sandbox.

Contoh:

User:

"Build a web application for me."

NEXUS:

1. Membuat sandbox baru.
2. Menentukan model AI yang digunakan.
3. Memberikan filesystem kepada agent.
4. Agent menggunakan terminal.
5. Agent membuat source code.
6. Agent menginstall dependency.
7. Agent menjalankan application.
8. Agent membuka browser.
9. Agent melakukan testing.
10. Agent menemukan error.
11. Agent memperbaiki code.
12. Agent menjalankan test kembali.
13. Agent menghasilkan artifact.
14. Semua aktivitas dicatat.
15. User dapat melihat seluruh proses dan melakukan replay.

Semua pekerjaan AI harus terjadi di environment terisolasi.

---

2. CORE ARCHITECTURE

Gunakan arsitektur modular.

Struktur konsep:

NEXUS
│
├── Control Plane
│   ├── API Gateway
│   ├── Authentication
│   ├── Agent Manager
│   ├── Sandbox Manager
│   ├── Task Manager
│   ├── Model Router
│   └── Permission Manager
│
├── Agent Runtime
│   ├── Planner
│   ├── Executor
│   ├── Tool Manager
│   ├── Memory Manager
│   ├── Context Manager
│   └── Agent Loop
│
├── Sandbox Runtime
│   ├── Filesystem
│   ├── Terminal
│   ├── Process Manager
│   ├── Network Isolation
│   ├── Browser
│   ├── Database
│   └── Resource Limits
│
├── Multi-Agent System
│   ├── Worker Agents
│   ├── Agent Communication
│   ├── Task Delegation
│   └── Shared Workspace
│
├── Memory
│   ├── Short-Term Memory
│   ├── Long-Term Memory
│   ├── Project Memory
│   └── Semantic Retrieval
│
├── Observability
│   ├── Logs
│   ├── Events
│   ├── Metrics
│   ├── Traces
│   └── Replay
│
├── Storage
│   ├── Metadata Database
│   ├── Object Storage
│   ├── Vector Storage
│   └── Sandbox Storage
│
└── Dashboard
├── Agents
├── Sandboxes
├── Tasks
├── Terminal
├── Files
├── Logs
├── Events
├── Replay
└── System Metrics

---

3. MODEL AGNOSTIC

Jangan mengunci NEXUS ke satu AI provider.

Buat abstraction layer:

Model Provider
→ Model Adapter
→ Agent Runtime

Minimal desain harus memungkinkan:

- OpenAI-compatible APIs
- Anthropic-compatible APIs
- Google models
- DeepSeek
- Qwen
- local models
- Ollama
- llama.cpp
- custom API providers

Buat interface provider yang jelas sehingga provider baru dapat ditambahkan tanpa mengubah Agent Runtime.

Contoh konsep:

ModelProvider
├── chat()
├── stream()
├── tool_call()
├── embeddings()
└── metadata()

Jangan hardcode API key.

Gunakan environment variables dan secure configuration.

---

4. AGENT RUNTIME

Buat agent loop yang modular.

Konsep:

OBSERVE
↓
THINK / PLAN
↓
SELECT TOOL
↓
EXECUTE
↓
OBSERVE RESULT
↓
UPDATE MEMORY
↓
CONTINUE
↓
FINISH

Agent harus dapat:

- membaca file
- membuat file
- mengedit file
- menjalankan command
- menjalankan program
- menggunakan browser
- melakukan HTTP request melalui permission system
- menggunakan database
- memanggil tools
- membuat sub-agent
- menerima hasil dari sub-agent
- menyimpan memory
- menghasilkan artifact

Tool calling harus terstruktur.

Jangan parsing output AI menggunakan string hack jika structured tool calling dapat digunakan.

---

5. SANDBOX

Sandbox adalah komponen paling penting.

Setiap agent harus dapat memiliki isolated environment.

Sandbox harus mempunyai:

- isolated filesystem
- working directory
- process isolation
- CPU limit
- RAM limit
- disk limit
- execution timeout
- network policy
- environment variables
- package installation
- process lifecycle
- snapshot
- restore
- destroy

Jangan menjalankan arbitrary agent commands langsung pada host machine.

Gunakan isolation technology yang sesuai dengan OS/environment.

Prioritaskan:

1. container isolation
2. resource limits
3. network restrictions
4. filesystem isolation
5. privilege reduction

Arsitektur sandbox harus dibuat supaya runtime lain dapat ditambahkan di masa depan.

Contoh:

SandboxRuntime
├── DockerRuntime
├── PodmanRuntime
└── FutureRuntime

---

6. SECURITY

Security harus menjadi bagian fundamental, bukan fitur tambahan.

Implementasikan:

- permission system
- tool permissions
- network allowlist/denylist
- filesystem restrictions
- command restrictions bila diperlukan
- resource limits
- timeout
- process cleanup
- secret isolation
- audit logs
- sandbox isolation
- authentication
- authorization

AI tidak boleh otomatis mempunyai akses penuh ke host.

Setiap tool invocation harus dapat menghasilkan audit event.

Contoh:

agent-123
→ terminal.execute
→ command="npm install"
→ sandbox="sandbox-456"
→ timestamp
→ result
→ exit_code

---

7. TOOL SYSTEM

Buat universal tool registry.

Konsep:

Tool Registry
│
├── filesystem
├── terminal
├── browser
├── http
├── database
├── git
├── python
├── code execution
└── custom tools

Setiap tool mempunyai:

- name
- description
- input schema
- output schema
- permission requirement
- timeout
- execution handler

Tool system harus mudah diperluas.

---

8. MCP COMPATIBILITY

Buat architecture yang memungkinkan NEXUS menggunakan MCP tools.

NEXUS harus dapat menjadi:

MCP Client

dan jika memungkinkan di masa depan:

MCP Server

Jangan membuat MCP implementation terlalu tightly coupled dengan Agent Runtime.

Buat adapter layer.

---

9. MULTI-AGENT

NEXUS harus mendukung banyak agent.

Contoh:

MAIN AGENT
│
├── CODER AGENT
├── RESEARCH AGENT
├── TESTER AGENT
├── SECURITY AGENT
└── REVIEWER AGENT

Main agent dapat:

- membuat worker
- memberikan task
- menerima hasil
- berbagi artifact
- berbagi project workspace
- menghentikan worker
- menggabungkan hasil

Buat Agent Manager.

Setiap agent harus mempunyai:

- agent_id
- role
- model
- status
- permissions
- sandbox
- memory
- current_task

---

10. MEMORY

Buat memory abstraction.

Minimal:

Short-Term Memory
Long-Term Memory
Project Memory

Memory harus dapat menyimpan:

- conversation context
- task history
- important facts
- project information
- previous decisions
- tool results
- generated artifacts

Buat interface storage agar vector database dapat diganti.

Jangan mengunci implementation ke satu vector DB.

---

11. EVENT SYSTEM

Semua aktivitas penting harus menghasilkan event.

Contoh:

agent.created
agent.started
agent.thinking
agent.tool_called
agent.tool_finished
sandbox.created
sandbox.started
sandbox.destroyed
file.created
file.modified
terminal.started
terminal.finished
task.created
task.completed
task.failed
memory.created
artifact.created

Gunakan event architecture yang scalable.

Event harus bisa digunakan oleh:

- dashboard
- logging
- audit
- replay
- metrics
- future integrations

---

12. REPLAY ENGINE

Ini adalah salah satu fitur utama NEXUS.

Simpan execution history agent.

Contoh:

T+00:01
Agent started

T+00:05
Created main.py

T+00:08
Executed python main.py

T+00:09
Process failed

T+00:12
Modified main.py

T+00:15
Executed test

T+00:16
Test passed

User harus dapat melihat timeline tersebut.

Arsitektur harus memungkinkan:

- event replay
- execution timeline
- tool call inspection
- command history
- file changes
- snapshots
- restore state

Future goal:

User dapat melakukan:

"Replay this agent session."

---

13. SNAPSHOT SYSTEM

Sandbox harus dapat dibuat snapshot.

Contoh:

sandbox-001
│
├── snapshot-001
├── snapshot-002
├── snapshot-003
└── current

User dapat:

- create snapshot
- restore snapshot
- clone sandbox
- delete snapshot

Pastikan abstraction memungkinkan storage backend berbeda.

---

14. DASHBOARD

Buat web dashboard modern.

Dashboard harus mempunyai:

Overview

Agents

Sandboxes

Tasks

Terminal

Files

Logs

Events

Memory

Models

Tools

Settings

Replay

System Metrics

Untuk Agent Detail:

Agent Status
Current Task
Model
Token Usage
Tool Calls
Memory
Sandbox
Timeline
Logs

Untuk Sandbox Detail:

CPU
RAM
Disk
Network
Processes
Files
Terminal
Logs
Snapshot

Dashboard harus real-time menggunakan WebSocket atau mekanisme realtime yang sesuai.

---

15. API

Buat REST API yang jelas.

Contoh:

POST /api/agents
GET /api/agents
GET /api/agents/:id
DELETE /api/agents/:id

POST /api/sandboxes
GET /api/sandboxes
GET /api/sandboxes/:id
POST /api/sandboxes/:id/start
POST /api/sandboxes/:id/stop
POST /api/sandboxes/:id/snapshot
POST /api/sandboxes/:id/restore

POST /api/tasks
GET /api/tasks
GET /api/tasks/:id

GET /api/events
GET /api/logs

POST /api/models
GET /api/models

API harus terdokumentasi menggunakan OpenAPI.

---

16. CLI

Buat CLI bernama:

nexus

Contoh:

nexus agent create coder
nexus agent list
nexus agent run coder
nexus agent stop coder

nexus sandbox create
nexus sandbox list
nexus sandbox shell
nexus sandbox snapshot
nexus sandbox restore

nexus task create
nexus task status

nexus logs
nexus events

CLI harus dapat digunakan tanpa dashboard.

---

17. DATABASE

Gunakan relational database untuk metadata.

Schema minimal:

users
agents
agent_sessions
tasks
sandboxes
sandbox_snapshots
tools
tool_calls
events
logs
memories
artifacts
models
providers
permissions

Gunakan migration system.

Jangan membuat schema yang sulit dimigrasikan.

---

18. PROJECT STRUCTURE

Gunakan monorepo jika sesuai.

Contoh:

nexus/
├── apps/
│   ├── api/
│   ├── dashboard/
│   └── cli/
│
├── packages/
│   ├── agent-runtime/
│   ├── sandbox-runtime/
│   ├── tool-system/
│   ├── memory/
│   ├── model-providers/
│   ├── event-system/
│   ├── security/
│   └── shared/
│
├── infrastructure/
│   ├── docker/
│   └── deployment/
│
├── docs/
├── examples/
├── tests/
├── scripts/
└── README.md

Sesuaikan struktur jika ada alasan teknis yang lebih baik.

---

19. DEVELOPMENT PRINCIPLES

Prioritaskan:

- modularity
- maintainability
- security
- observability
- testability
- extensibility
- documentation
- clean APIs

Jangan membuat prototype yang hanya bekerja pada satu kasus.

Tetapi juga jangan over-engineer tanpa alasan.

Bangun sistem secara incremental.

---

20. MVP

Jangan langsung mencoba menyelesaikan semuanya.

Mulai dengan MVP yang benar-benar berjalan:

MVP v0.1:

User
↓
Create Agent
↓
Create Sandbox
↓
Agent receives task
↓
Agent can use:

- filesystem
- terminal
  ↓
  Agent executes task
  ↓
  Events recorded
  ↓
  Logs recorded
  ↓
  Result returned

Setelah MVP stabil:

v0.2

- browser
- model providers
- tool registry
- dashboard

v0.3

- memory
- snapshots
- replay

v0.4

- multi-agent
- MCP

v0.5

- distributed sandbox
- workers
- queues

v1.0

- production-grade security
- scalable architecture
- documentation
- SDK
- plugin ecosystem

---

21. TESTING

Setiap subsystem harus memiliki test.

Minimal:

unit tests
integration tests
API tests
sandbox tests
security tests
agent runtime tests

Buat automated test suite.

Jangan menganggap project selesai hanya karena server berhasil start.

---

22. DOCUMENTATION

Buat:

README.md

ARCHITECTURE.md

SECURITY.md

CONTRIBUTING.md

DEVELOPMENT.md

API.md

docs/

README harus menjelaskan:

Apa itu NEXUS
Mengapa NEXUS dibuat
Architecture
Quick Start
Installation
First Agent
First Sandbox
Tool System
Security
Development
Roadmap

---

23. DO NOT

Jangan:

- hardcode API keys
- memberikan agent akses host secara default
- membuat seluruh code menjadi satu file besar
- membuat provider AI tightly coupled
- membuat sandbox hanya berupa folder biasa
- menyimpan secret dalam repository
- mengabaikan error handling
- mengabaikan cleanup process
- mengabaikan resource limits
- membuat fake implementation lalu menganggap fitur selesai
- membuat UI dulu sementara backend belum memiliki architecture yang jelas

---

24. AUTONOMOUS DEVELOPMENT RULE

Kamu boleh mengambil keputusan teknis sendiri jika detail tidak ditentukan.

Jika ada beberapa pilihan teknologi, pilih yang:

1. open-source
2. mature
3. mudah dikembangkan
4. mudah self-host
5. aman
6. tidak mengunci project ke vendor

Jangan berhenti hanya karena ada detail kecil yang belum ditentukan.

Jika sebuah keputusan penting benar-benar membutuhkan input manusia, dokumentasikan keputusan tersebut dan gunakan default yang paling masuk akal untuk melanjutkan development.

---

25. WORKFLOW

Sebelum coding:

1. Inspect repository.
2. Tentukan apakah repository kosong atau sudah memiliki code.
3. Buat ARCHITECTURE.md.
4. Tentukan technology stack.
5. Buat directory structure.
6. Buat development roadmap.

Kemudian implementasikan secara bertahap.

Setelah setiap milestone:

1. Jalankan tests.
2. Jalankan lint.
3. Jalankan type checking jika digunakan.
4. Jalankan application.
5. Verifikasi functionality.
6. Perbaiki error.
7. Update documentation.

Jangan hanya menulis code tanpa menjalankannya.

---

26. FIRST OBJECTIVE

Objective pertama:

Buat NEXUS MVP yang benar-benar bisa menjalankan satu AI agent di sandbox terisolasi.

Flow:

User
→ API
→ Task Manager
→ Agent Runtime
→ Model Provider
→ Tool System
→ Sandbox
→ Terminal / Filesystem
→ Event System
→ Result

Harus dapat mendemonstrasikan task seperti:

"Create a Python program that calculates Fibonacci numbers, run it, test it, and return the result."

Agent harus benar-benar membuat file dan menjalankan program di sandbox.

---

27. FINAL GOAL

Jangan melihat NEXUS sebagai chatbot.

Anggap NEXUS sebagai:

"A programmable operating environment where autonomous AI agents can safely live and work."

Target jangka panjang:

AI Agent
+
Computer Environment
+
Tools
+
Memory
+
Multi-Agent
+
Security
+
Observability
+
Replay
+
Distributed Infrastructure

menjadi satu platform open-source.

Mulai dari MVP yang kecil tetapi architecture-nya harus mampu berkembang menjadi sistem besar.

Sekarang inspect repository dan environment terlebih dahulu.

Setelah itu buat implementation plan dan mulai mengimplementasikan MVP.

Jangan hanya memberikan saya penjelasan atau pseudocode. Kerjakan project-nya langsung di repository.