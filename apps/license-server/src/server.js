// License server bootstrap — self-hosted :8486 by default.
//   node apps/license-server/src/server.js [--port=N] [--store=PATH] [--secret=...]
//
// Env:
//   LICENSE_PORT      default 8486
//   LICENSE_STORE     path to the JSONL key store (default: ./license-store.jsonl)
//   LICENSE_SECRET    HMAC secret for signing keys (required, >= 32 bytes)
//   LICENSE_ADMIN_SECRET  admin token for issue/list routes
//   LICENSE_SEED_PRO  comma-separated pre-authorized pro keys
//   LICENSE_SEED_ENTERPRISE  comma-separated pre-authorized enterprise keys

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { LicenseStore } from './store.js';
import { makeLicenseApi } from './api.js';

export function startLicenseServer(opts = {}) {
  const host = opts.host ?? process.env.LICENSE_HOST ?? '0.0.0.0';
  const port = Number(opts.port ?? process.env.LICENSE_PORT ?? 8486);
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultStore = join(here, '..', 'data', 'license-store.jsonl');
  const storePath = opts.store ?? process.env.LICENSE_STORE ?? defaultStore;
  const secret = opts.secret ?? process.env.LICENSE_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('LICENSE_SECRET required (>= 32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  const adminSecret = opts.adminSecret ?? process.env.LICENSE_ADMIN_SECRET;

  mkdirSync(dirname(storePath), { recursive: true });
  const store = new LicenseStore({
    path: storePath,
    secret,
    seedPro: (process.env.LICENSE_SEED_PRO || '').split(',').filter(Boolean),
    seedEnterprise: (process.env.LICENSE_SEED_ENTERPRISE || '').split(',').filter(Boolean),
  });
  const api = makeLicenseApi({ store, adminSecret });
  const server = createServer(api);

  server.listen(port, host, () => {
    const demoKey = store.issue('pro');
    // eslint-disable-next-line no-console
    console.log(`license-server listening on http://${host}:${port}`);
    // eslint-disable-next-line no-console
    console.log(`store: ${storePath} (${store.list().length} keys)`);
    // eslint-disable-next-line no-console
    console.log(`demo pro key: ${demoKey.key}`);
  });

  return { server, store };
}

// Run directly: node src/server.js [--port=N] [--store=PATH] [--secret=...]
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const optOf = (name, d) => {
    const i = argv.indexOf(name);
    return i > -1 && argv[i + 1] ? argv[i + 1] : d;
  };
  const opts = {
    port: optOf('--port'),
    store: optOf('--store'),
    secret: optOf('--secret'),
    adminSecret: optOf('--admin-secret'),
  };
  try {
    startLicenseServer(opts);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e.message);
    process.exit(1);
  }
}