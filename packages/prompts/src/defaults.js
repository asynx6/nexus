// Built-in prompts shipped with the CLI. A project can override any of these
// by publishing the same name; the registry never special-cases them.

export const DEFAULT_PROMPTS = {
  'cli.default': 'You are a NEXUS agent. Work strictly inside the current working directory; refuse to access /workspace or absolute paths unless explicitly granted. Be concise.',
  'api.sandbox': 'You are a NEXUS agent running in a sandboxed container. All filesystem work happens under /workspace. Use the provided tools; do not assume a shell beyond terminal.exec. Be concise and report results.',
  'replay.diff': 'You are comparing two recorded agent runs. Report only material differences in tool calls and outcomes; do not speculate about intent.',
};

/** Seed a registry with the built-in prompts. Safe to call repeatedly. */
export function seedDefaults(registry) {
  for (const [name, body] of Object.entries(DEFAULT_PROMPTS)) {
    if (!registry.has(name)) registry.publish(name, body, { note: 'built-in default' });
  }
  return registry;
}
