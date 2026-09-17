#!/usr/bin/env node
// nexus bin — entry point for `nexus` command.
// Usage: nexus <subcommand> [args]
import { runNexusCli } from './src/cli.js';
const code = await runNexusCli(process.argv.slice(2));
process.exit(code ?? 1);
