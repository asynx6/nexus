// Tests for nexus-mcp server
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexusMcpServer } from '../src/index.js';

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-test-'));
  const storePath = join(dir, 'events.jsonl');
  const server = new NexusMcpServer({ eventStorePath: storePath });
  return { server, dir, storePath };
}

function cleanup(dir) {
  // best-effort: try a few times to handle Windows file lock timing
  for (let i = 0; i < 3; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { /* retry */ }
  }
}

test('initialize returns protocolVersion + capabilities', async () => {
  const { server, dir } = makeServer();
  const res = JSON.parse(await server.handle(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {}
  })));
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.result.serverInfo.name, 'nexus-mcp');
  server.close();
  cleanup(dir);
});

test('tools/list returns 5 tools', async () => {
  const { server, dir } = makeServer();
  const res = JSON.parse(await server.handle(JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
  })));
  assert.equal(res.result.tools.length, 5);
  const names = res.result.tools.map(t => t.name);
  assert.ok(names.includes('nexus_run_agent'));
  assert.ok(names.includes('nexus_list_tasks'));
  server.close();
  cleanup(dir);
});

test('tools/call nexus_query_events returns events', async () => {
  const { server, dir, storePath } = makeServer();
  // seed events
  writeFileSync(storePath, JSON.stringify({ seq: 1, subject: 'task-1', type: 'task.created', ts: '2026-01-01T00:00:00Z' }) + '\n');
  writeFileSync(storePath, JSON.stringify({ seq: 2, subject: 'task-1', type: 'task.started', ts: '2026-01-01T00:00:01Z' }) + '\n', { flag: 'a' });

  const res = JSON.parse(await server.handle(JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'nexus_query_events', arguments: { subject: 'task-1' } }
  })));
  assert.ok(res.result.content);
  assert.equal(res.result.content[0].type, 'text');
  server.close();
  cleanup(dir);
});

test('invalid JSON returns parse error', async () => {
  const { server, dir } = makeServer();
  const res = JSON.parse(await server.handle('not-json'));
  assert.equal(res.error.code, -32700);
  server.close();
  cleanup(dir);
});

test('unknown method returns error', async () => {
  const { server, dir } = makeServer();
  const res = JSON.parse(await server.handle(JSON.stringify({
    jsonrpc: '2.0', id: 9, method: 'no_such_method', params: {}
  })));
  assert.match(res.error.message, /Method not found/);
  server.close();
  cleanup(dir);
});

test('tools/call unknown tool returns error', async () => {
  const { server, dir } = makeServer();
  const res = JSON.parse(await server.handle(JSON.stringify({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} }
  })));
  assert.match(res.error.message, /Unknown tool/);
  server.close();
  cleanup(dir);
});
