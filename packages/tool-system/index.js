// @nexus/tool-system — ToolRegistry + filesystem/terminal tools wired through
// permissions + events (plan P05). Public facade only (ARCHITECTURE.md rule 4).
export const NAME = '@nexus/tool-system';
export { ToolRegistry } from './src/registry.js';
export { ToolExecutor } from './src/executor.js';
export { validateArgs } from './src/schema.js';
export { fsTools } from './src/tools/fs.js';
export { terminalTools } from './src/tools/terminal.js';
