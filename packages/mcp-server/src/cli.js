#!/usr/bin/env node
// nexus-mcp CLI entrypoint
// Usage:
//   nexus-mcp stdio                    # JSON-RPC over stdio (default for MCP-aware clients)
//   nexus-mcp http --port 9090         # JSON-RPC over HTTP
//   nexus-mcp --event-store ./events.jsonl
import { NexusMcpServer, runStdio, runHttp } from './index.js';

const args = process.argv.slice(2);
const mode = args[0] === 'http' ? 'http' : 'stdio';

const opts = {};
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--port') opts.port = parseInt(args[++i], 10);
  else if (args[i] === '--host') opts.host = args[++i];
  else if (args[i] === '--event-store') opts.eventStorePath = args[++i];
}

const server = new NexusMcpServer(opts);

if (mode === 'http') {
  await runHttp(server, opts);
} else {
  await runStdio(server);
}
