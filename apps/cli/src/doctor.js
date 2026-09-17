// nexus doctor — comprehensive environment health check.
// Run before first agent invocation to catch setup issues early.
// Zero deps, stdlib only.
import { existsSync, statSync } from 'node:fs';
import { hostname, platform, arch } from 'node:os';
import { version as nodeVersion } from 'node:process';
import { execFileSync } from 'node:child_process';

export async function runDoctor({ env = process.env, stdout = console.log, exec = execFileSync } = {}) {
  const ok = (label, detail = '') => stdout(`  ok    ${label} ${detail}`);
  const warn = (label, detail = '') => stdout(`  warn  ${label} ${detail}`);
  const fail = (label, detail = '') => stdout(`  fail  ${label} ${detail}`);
  let exit = 0;
  stdout('nexus doctor — environment health check\n');

  // Node version
  const v = nodeVersion;
  const major = parseInt(v.slice(1).split('.')[0], 10);
  if (major >= 22) ok('Node.js version', `${v}`);
  else { fail('Node.js version', `${v} — need >= 22 for node:sqlite`); exit = 2; }

  // Platform
  ok('Platform', `${platform()} ${arch()} (${hostname()})`);

  // Env file
  if (existsSync('.env')) ok('Env file', '.env present');
  else if (existsSync('.env-gateway')) ok('Env file', '.env-gateway present');
  else warn('Env file', 'not present; using environment variables');

  // Gateway config
  const base = env.NEXUS_GATEWAY_BASE ?? 'https://api.asynx6.tech/v1';
  const key = env.NEXUS_GATEWAY_KEY;
  if (key) ok('Gateway key', 'set');
  else { fail('Gateway key', 'NEXUS_GATEWAY_KEY not set'); exit = 2; }

  // Models
  const models = (env.NEXUS_GATEWAY_MODELS ?? 'hermes-agent').split(',').map((s) => s.trim());
  ok('Models configured', models.join(', '));

  // Gateway reachability
  try {
    const r = await fetch(base + '/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 200) ok('Gateway reachable', `${base} (200)`);
    else { fail('Gateway reachable', `HTTP ${r.status}`); exit = 2; }
  } catch (e) {
    fail('Gateway reachable', `${base} — ${e.message}`);
    exit = 2;
  }

  // node:sqlite available (Node 22 has it built-in)
  try {
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1)');
    const row = db.prepare('SELECT x FROM t').get();
    db.close();
    if (row.x === 1) ok('node:sqlite', 'in-memory round-trip ok');
  } catch (e) {
    fail('node:sqlite', e.message);
    exit = 2;
  }

  // Event store directory presence (not a write-permission check).
  const storeDir = './.nexus/store';
  try {
    statSync(storeDir);
    ok('Event store dir', storeDir);
  } catch {
    warn('Event store dir', `${storeDir} not present — will be created on first run`);
  }

  // Docker (optional but recommended for sandbox)
  try {
    const dockerVer = exec('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    ok('Docker daemon (optional)', dockerVer);
  } catch {
    warn('Docker daemon (optional)', 'unavailable; sandbox execution is not verified');
  }

  stdout(exit === 0 ? '\nRequired checks passed. Review warnings above.' : '\nIssues found. See above.');
  return exit;
}
