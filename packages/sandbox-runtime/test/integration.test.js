// Integration tests — REQUIRE a live Docker Engine. Skipped automatically when
// /var/run/docker.sock is unreachable, so CI without Docker stays green.
// Run on a Docker box: node --test test/integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DockerRuntime, LABEL_MANAGED_BY, LABEL_MANAGED_VALUE } from '../index.js';

const SOCKET = process.env.NEXUS_DOCKER_SOCKET ?? '/var/run/docker.sock';
const hasDocker = fs.existsSync(SOCKET);
const t = hasDocker ? test : test.skip;

let rt;
before(async () => {
  rt = new DockerRuntime({ socketPath: SOCKET });
  if (hasDocker) {
    // CI runners ship a live daemon with NO pre-pulled images; create() 404s
    // otherwise. ensureImage is a no-op when the daemon already has them.
    await rt.ensureImage('alpine:3.20');
    await rt.ensureImage('python:3.12-slim');
  }
});
after(async () => {
  for (const id of [...rt.containers.keys()]) {
    try { await rt.stop(id, 500); await rt.rm(id); } catch { /* best effort */ }
  }
});

t('exec echo returns stdout and exit 0', async () => {
  const id = await rt.create({ image: 'alpine:3.20', cpus: 0.5, memoryMb: 128 });
  await rt.start(id);
  const r = await rt.exec(id, ['echo', 'nexus-p03']);
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout.trim(), 'nexus-p03');
  await rt.stop(id);
  await rt.rm(id);
});

t('exec python runs code and propagates nonzero exit', async () => {
  const id = await rt.create({ memoryMb: 256 });
  await rt.start(id);
  const ok = await rt.exec(id, ['python', '-c', 'print(sum(range(10)))']);
  assert.strictEqual(ok.exitCode, 0);
  assert.strictEqual(ok.stdout.trim(), '45');
  const bad = await rt.exec(id, ['python', '-c', 'import sys; sys.exit(3)']);
  assert.strictEqual(bad.exitCode, 3);
  await rt.stop(id);
  await rt.rm(id);
});

t('copyIn + run copied script', async () => {
  const id = await rt.create({ memoryMb: 256 });
  await rt.start(id);
  await rt.copyIn(id, [{ path: '/tmp/fib.py', content: 'a,b=0,1\nfor _ in range(10):\n  a,b=b,a+b\nprint(a)\n' }]);
  const r = await rt.exec(id, ['python', '/tmp/fib.py']);
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout.trim(), '55');
  await rt.stop(id);
  await rt.rm(id);
});

t('memory limit is enforced: OOM kill on big allocation', async () => {
  const id = await rt.create({ memoryMb: 128 });
  await rt.start(id);
  // ~1GB bytearray: must die under a 128MiB cgroup limit
  const r = await rt.exec(id, ['python', '-c', 'x=bytearray(1024*1024*1000); print(len(x))'], { timeoutMs: 20_000 });
  assert.ok(r.exitCode !== 0, `expected nonzero exit, got ${r.exitCode} out=${r.stdout}`);
  assert.ok(!r.stdout.includes('1048576000'));
  await rt.stop(id);
  await rt.rm(id);
});

t('hard timeout kills a sleep loop', async () => {
  const id = await rt.create({ memoryMb: 128 });
  await rt.start(id);
  const r = await rt.exec(id, ['python', '-c', 'import time; time.sleep(60)'], { timeoutMs: 2000 });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.exitCode, -1);
  await rt.stop(id);
  await rt.rm(id);
});

t('network policy: none blocks DNS/TCP, bridge allows egress', async () => {
  const none = await rt.create({ image: 'alpine:3.20', network: 'none', memoryMb: 64 });
  await rt.start(none);
  const blocked = await rt.exec(none, ['sh', '-c', 'wget -q -T 5 -O /dev/null http://example.com || echo NO_NET'], { timeoutMs: 15_000 });
  assert.ok(blocked.stdout.includes('NO_NET'));
  await rt.stop(none);
  await rt.rm(none);

  const bridge = await rt.create({ image: 'alpine:3.20', network: 'bridge', memoryMb: 64 });
  await rt.start(bridge);
  const open = await rt.exec(bridge, ['sh', '-c', 'wget -q -T 10 -O /dev/null http://example.com && echo HAS_NET || true'], { timeoutMs: 20_000 });
  assert.ok(open.stdout.includes('HAS_NET'), `bridge egress failed: ${open.stderr}`);
  await rt.stop(bridge);
  await rt.rm(bridge);
});

t('pids limit: fork bomb fails instead of hanging host', async () => {
  const id = await rt.create({ image: 'alpine:3.20', pidsLimit: 16, memoryMb: 64 });
  await rt.start(id);
  const r = await rt.exec(id, ['sh', '-c', 'i=0; while [ $i -lt 300 ]; do (sleep 5) & i=$((i+1)); done; fail=0; j=0; while [ $j -lt 300 ]; do wait || fail=1; j=$((j+1)); done; echo forks_done fail=$fail'], { timeoutMs: 25_000 });
  // some backgrounds must have failed to spawn under pids cgroup
  assert.ok(r.timedOut || r.stdout.includes('fail=1') || r.stderr.length > 0, `fork bomb not contained: ${JSON.stringify(r)}`);
  await rt.stop(id);
  await rt.rm(id);
});

t('cleanupOrphans removes managed containers left behind', async () => {
  // simulate a leak: create via raw API without tracking, then clean
  const leak = new DockerRuntime({ socketPath: SOCKET });
  const id = await leak.create({ image: 'alpine:3.20', name: `leak-${Date.now()}` });
  await leak.start(id);
  const orphanRt = new DockerRuntime({ socketPath: SOCKET }); // fresh runtime, empty tracking
  const removed = await orphanRt.cleanupOrphans();
  assert.ok(removed.some((n) => n.startsWith('leak-')), `removed=${removed}`);
  await leak.rm(id).catch(() => {}); // already gone
});

t('unknown sandbox id throws', async () => {
  await assert.rejects(() => rt.exec('sbx-nope', ['echo']), /unknown sandbox id/);
});
