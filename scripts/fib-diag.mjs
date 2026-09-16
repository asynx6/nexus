#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const K = process.env.NEXUS_GATEWAY_KEY;
if (!K) { console.error('set NEXUS_GATEWAY_KEY first'); process.exit(2); }
process.env.NEXUS_GATEWAY_BASE = 'https://api.asynx6.tech/v1';
process.env.NEXUS_GATEWAY_MODELS = 'hermes-agent';
const here = dirname(fileURLToPath(import.meta.url));
const testPath = resolve(here, '../apps/cli/test/e2e-fib.test.js');
try {
  const out = execFileSync('node', ['--test', testPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  writeFileSync('/tmp/fib-out.txt', out);
  console.log('PASS out=/tmp/fib-out.txt len=' + out.length);
} catch (e) {
  const txt = (e.stdout || '') + '\n---STDERR---\n' + (e.stderr || '');
  writeFileSync('/tmp/fib-out.txt', txt);
  console.log('FAIL out=/tmp/fib-out.txt len=' + txt.length);
}
