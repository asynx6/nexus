// nexus doctor tests — env health check.
import { test } from 'node:test';
import assert from 'node:assert';
import { runNexusCli } from '../src/cli.js';
import { createServer } from 'node:http';
import { runDoctor } from '../src/doctor.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('published CLI entry point displays doctor help', () => {
  const bin = fileURLToPath(new URL('../bin.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nexus doctor/);
});

test('doctor checks Docker daemon, not only CLI installation', async () => {
  const calls = [];
  await runDoctor({
    env: { NEXUS_GATEWAY_BASE: 'http://127.0.0.1:1/v1' },
    stdout: () => {},
    exec: (file, args) => { calls.push([file, args]); return '26.0.0'; },
  });
  assert.deepEqual(calls, [['docker', ['info', '--format', '{{.ServerVersion}}']]]);
});
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('doctor accepts environment-only config without a dotenv file', async (t) => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'nexus-doctor-'));
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/v1/models' ? 200 : 404);
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { process.chdir(cwd); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  process.chdir(dir);
  const lines = [];
  const code = await runNexusCli(['doctor'], {
    NEXUS_GATEWAY_BASE: `http://127.0.0.1:${server.address().port}/v1`,
    NEXUS_GATEWAY_KEY: 'test-only-key',
  }, line => lines.push(line));
  assert.equal(code, 0, lines.join('\n'));
  assert.doesNotMatch(lines.join('\n'), /test-only-key/);
});

test('runNexusCli: doctor reports environment state without crashing', async () => {
  let buf = '';
  let err = '';
  const code = await runNexusCli(
    ['doctor'],
    { NEXUS_GATEWAY_BASE: 'http://127.0.0.1:1/v1', NEXUS_GATEWAY_KEY: 'test' },
    (s) => { buf += s + '\n'; },
    (s) => { err += s; }
  );
  assert.strictEqual(code, 2);
  assert.match(buf, /nexus doctor/);
  assert.match(buf, /Node\.js version/);
  assert.match(buf, /node:sqlite/);
});

test('runNexusCli: doctor help line in --help', async () => {
  let buf = '';
  await runNexusCli(['help'], {}, (s) => { buf += s; }, () => {});
  assert.match(buf, /nexus doctor/);
});
