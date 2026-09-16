// Tiny env loader: parses KEY=value lines from a .env file WITHOUT overriding
// real process.env (explicit env wins). No secrets logged, ever.
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(path = '.env') {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i);
    if (process.env[k] === undefined) {
      process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    out[k] = true; // keys only — never values
  }
  return out;
}
