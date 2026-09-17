#!/usr/bin/env node
// nexus bin — entry point for `nexus` command.
// Usage: nexus <subcommand> [args]
import { readFileSync } from 'node:fs';
import { runNexusCli } from './src/cli.js';
if (process.argv.length === 3 && process.argv[2] === '--version') {
  console.log(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version);
} else {
  const code = await runNexusCli(process.argv.slice(2));
  process.exitCode = code ?? 1;
}
