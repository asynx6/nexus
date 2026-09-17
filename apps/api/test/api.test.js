// P08 control-plane tests: wired app against FakeRuntime, real EventBus + EventStore + PermissionManager + AuditTrail + ToolRegistry/Executor + ModelProvider (stubbed via env). HTTP exercised via in-process dispatch.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { callApi, FakeRuntime } from "./helpers.js";

function freshEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-api-test-"));
  return {
    NEXUS_DATA_DIR: dir,
    NEXUS_GATEWAY_BASE: "http://gateway.invalid/v1",
    NEXUS_GATEWAY_KEY: "sk-test-fake-key",
    NEXUS_GATEWAY_MODELS: "fake/model",
    NEXUS_API_TOKEN: "tok-test-1234567890",
    ...extra,
  };
}

async function withEnv(fn) {
  const env = freshEnv();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const runtime = new FakeRuntime();
  const app = await buildApp({ runtime });
  try { await fn(app); } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    rmSync(env.NEXUS_DATA_DIR, { recursive: true, force: true });
  }
}

const AUTH = { authorization: "Bearer tok-test-1234567890" };

test("GET /healthz returns 200 + ok", async () => {
  await withEnv(async (app) => {
    const r = await callApi(app.dispatch, { method: "GET", url: "/healthz", headers: AUTH });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json().ok, true);
  });
});

test("missing or bad bearer -> 401", async () => {
  await withEnv(async (app) => {
    const r1 = await callApi(app.dispatch, { method: "GET", url: "/tasks" });
    assert.strictEqual(r1.status, 401);
    const r2 = await callApi(app.dispatch, { method: "GET", url: "/tasks", headers: { authorization: "Bearer wrong" } });
    assert.strictEqual(r2.status, 401);
    assert.strictEqual(r1.json().error, "unauthorized");
  });
});

test("POST /tasks happy: 202, sandbox created+started, row running, events recorded", async () => {
  await withEnv(async (app) => {
    const r = await callApi(app.dispatch, {
      method: "POST", url: "/tasks", headers: AUTH,
      body: { prompt: "echo hello", tools: ["fs.read"], maxSteps: 4 },
    });
    assert.strictEqual(r.status, 202);
    const j = r.json();
    assert.ok(j.id && j.id.startsWith("task-"));
    assert.ok(j.agentId && j.agentId.startsWith("agent-"));
    assert.ok(j.sandboxId && j.sandboxId.startsWith("sbx-fake-"));
    assert.strictEqual(j.status, "running");

    assert.strictEqual(app.runtime.created.length, 1);
    assert.ok(app.runtime.started.has(j.sandboxId));

    const get = await callApi(app.dispatch, { method: "GET", url: "/tasks/" + j.id, headers: AUTH });
    assert.strictEqual(get.status, 200);
    const body = get.json();
    assert.strictEqual(body.id, j.id);
    assert.strictEqual(body.status, "running");
    assert.strictEqual(body.prompt, "echo hello");

    const evs = [...app.eventStore.replay({ subject: j.id })];
    const names = evs.map((e) => e.name);
    assert.ok(names.includes("task.created"));
    assert.ok(names.includes("task.started"));
    const sbxEvs = [...app.eventStore.replay({ subject: j.sandboxId })];
    const sbxNames = sbxEvs.map((e) => e.name);
    assert.ok(sbxNames.includes("sandbox.created"));
    assert.ok(sbxNames.includes("sandbox.started"));
  });
});

test("POST /tasks validation: 400 on empty prompt", async () => {
  await withEnv(async (app) => {
    const r = await callApi(app.dispatch, { method: "POST", url: "/tasks", headers: AUTH, body: { prompt: "" } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json().error, "bad_request");
  });
});

test("POST /tasks validation: 400 on unsupported tool", async () => {
  await withEnv(async (app) => {
    const r = await callApi(app.dispatch, { method: "POST", url: "/tasks", headers: AUTH, body: { prompt: "x", tools: ["weird.unsupported"] } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json().message, /unsupported tool/);
  });
});

test("POST /tasks rejects bad JSON body with 400", async () => {
  await withEnv(async (app) => {
    const r = await callApi(app.dispatch, { method: "POST", url: "/tasks", headers: AUTH, body: "{not json" });
    assert.strictEqual(r.status, 400);
  });
});

test("GET /tasks/:id 404 on unknown id", async () => {
  await withEnv(async (app) => {
    const r = await callApi(app.dispatch, { method: "GET", url: "/tasks/task-deadbeef", headers: AUTH });
    assert.strictEqual(r.status, 404);
  });
});

test("GET /tasks lists accepted tasks", async () => {
  await withEnv(async (app) => {
    await callApi(app.dispatch, { method: "POST", url: "/tasks", headers: AUTH, body: { prompt: "a" } });
    await callApi(app.dispatch, { method: "POST", url: "/tasks", headers: AUTH, body: { prompt: "b" } });
    const list = await callApi(app.dispatch, { method: "GET", url: "/tasks", headers: AUTH });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json().tasks.length, 2);
  });
});

test("finished task ends up status=completed in store", async () => {
  await withEnv(async (app) => {
    const orig = globalThis.__nexus_model_providers__;
    globalThis.__nexus_model_providers__ = {
      ModelProvider: class { async chat() { return { content: "done", tool_call: null }; } },
    };
    try {
      const post = await callApi(app.dispatch, {
        method: "POST", url: "/tasks", headers: AUTH,
        body: { prompt: "finish now", tools: ["fs.read"], maxSteps: 2 },
      });
      const { id } = post.json();
      await app.taskStore.drain();
      const get = await callApi(app.dispatch, { method: "GET", url: "/tasks/" + id, headers: AUTH });
      const body = get.json();
      assert.strictEqual(body.status, "completed");
      assert.strictEqual(body.answer, "done");
    } finally {
      globalThis.__nexus_model_providers__ = orig;
    }
  });
});

test("agent crash -> status=failed with error message + task.failed event", async () => {
  await withEnv(async (app) => {
    const orig = globalThis.__nexus_model_providers__;
    globalThis.__nexus_model_providers__ = {
      ModelProvider: class { async chat() { throw new Error("gateway boom"); } },
    };
    try {
      const post = await callApi(app.dispatch, {
        method: "POST", url: "/tasks", headers: AUTH,
        body: { prompt: "crash me", tools: ["fs.read"], maxSteps: 1 },
      });
      const { id } = post.json();
      await app.taskStore.drain();
      const get = await callApi(app.dispatch, { method: "GET", url: "/tasks/" + id, headers: AUTH });
      const body = get.json();
      assert.strictEqual(body.status, "failed");
      assert.match(body.error, /gateway boom/);
      const evs = [...app.eventStore.replay({ subject: id })];
      assert.ok(evs.some((e) => e.name === "task.failed"));
    } finally {
      globalThis.__nexus_model_providers__ = orig;
    }
  });
});

test("SSE stream: replays historical events with correct content-type", async () => {
  await withEnv(async (app) => {
    const post = await callApi(app.dispatch, {
      method: "POST", url: "/tasks", headers: AUTH,
      body: { prompt: "streamme", tools: ["fs.read"] },
    });
    const { id, sandboxId } = post.json();

    const { Readable, Writable } = await import("node:stream");
    const req = new Readable({ read() {} });
    req.method = "GET";
    req.url = "/tasks/" + id + "/events";
    req.headers = AUTH;
    process.nextTick(() => { req.push(null); });

    const chunks = [];
    const res = new Writable({ write(c, _e, cb) { chunks.push(c.toString("utf8")); cb(); } });
    res.writeHead = function (s, h) { this.statusCode = s; this._headers = h || {}; this.headersSent = true; };
    res.setHeader = function (k, v) { (this._headers = this._headers || {})[k.toLowerCase()] = v; };
    res.write = function (c) { chunks.push(typeof c === "string" ? c : c.toString("utf8")); return true; };
    res.end = function () { this.writableEnded = true; };

    await app.dispatch(req, res);
    await new Promise((r) => setTimeout(r, 30));

    const text = chunks.join("");
    assert.match(text, /text\/event-stream/, "SSE content-type header");
    assert.match(text, /"name":"task\\.created"/, "replayed task.created event");
    assert.match(text, /"name":"task\\.started"/, "replayed task.started event");
    const all = [...app.eventStore.replay({ since: 0 })];
    assert.ok(all.some((e) => e.subject === sandboxId && e.name === "sandbox.created"), "sandbox.created in store");
  });
});

test("taskStore.drain keeps in-flight tasks alive (no false completion)", async () => {
  await withEnv(async (app) => {
    const orig = globalThis.__nexus_model_providers__;
    globalThis.__nexus_model_providers__ = {
      ModelProvider: class { async chat() { await new Promise(() => {}); } },
    };
    try {
      await callApi(app.dispatch, { method: "POST", url: "/tasks", headers: AUTH, body: { prompt: "hang" } });
      const drainPromise = app.taskStore.drain();
      const winner = await Promise.race([drainPromise.then(() => "drained"), new Promise((r) => setTimeout(() => r("timeout"), 100))]);
      assert.strictEqual(winner, "timeout");
    } finally {
      globalThis.__nexus_model_providers__ = orig;
      app.eventStore.close();
    }
  });
});
