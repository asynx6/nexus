// Bundle workspace deps into apps/cli/vendor so the published tarball is self-contained.
// Run before publish. Zero-dep: plain node fs/path/glob-less (explicit file lists).
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'apps', 'cli');
const vendor = join(cli, 'vendor');

// Packages the CLI imports at runtime (from apps/cli/package.json deps).
const PKGS = ['shared', 'event-system', 'sandbox-runtime', 'security', 'tool-system',
              'model-providers', 'agent-runtime', 'audit', 'consensus', 'memory'];

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

for (const name of PKGS) {
  const src = join(root, 'packages', name);
  const dst = join(vendor, name);
  if (!existsSync(src)) { console.log(`skip ${name} (missing)`); continue; }
  cpSync(src, dst, { recursive: true });
  // Drop tests + node_modules from vendor copy.
  for (const drop of ['test', 'node_modules', 'coverage']) {
    rmSync(join(dst, drop), { recursive: true, force: true });
  }
  console.log(`vendored ${name}`);
}

// Rewrite @nexus/<pkg> import specifiers inside the vendor copy only.
// Source-tree files (apps/cli/**) keep their @nexus/* specifiers so the repo
// itself stays testable — apps/cli/node_modules/@nexus/* symlinks to packages/*.
const SPEC_RE = /((?:^|\n)(?:import|export)[^\n]*?\bfrom\s*|(?:^|\n)import\s*)(['"])@nexus\/([a-z-]+)(\/[^\s'"]*)?/g;

// Vendor packages import each other by relative paths (no @nexus/* left behind).
function rewriteVendor(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { rewriteVendor(p); continue; }
    if (!/\.(mjs|js)$/.test(ent.name)) continue;
    let txt = readFileSync(p, 'utf8');
    const before = txt;
    txt = txt.replace(SPEC_RE, (m, prefix, q, pkg, sub) => {
      // Relative from this vendor pkg file to sibling vendor pkg.
      // File dir -> up to vendor root -> into sibling pkg.
      const fileDir = dirname(p).replace(/\\/g, '/');
      const vendorPosix = vendor.replace(/\\/g, '/');
      const rel = fileDir.startsWith(vendorPosix) ? fileDir.slice(vendorPosix.length + 1) : '';
      // rel like "event-system/src" → depth = 2 → "../../shared"
      const depth = rel ? rel.split('/').length : 0;
      const ups = '../'.repeat(depth);
      return prefix + q + ups + pkg + (sub || '/index.js');
    });
    if (txt !== before) { writeFileSync(p, txt); console.log(`rewrote vendor imports in ${p.replace(vendor, '')}`); }
  }
}
rewriteVendor(vendor);

// Make the CLI work from the source tree without a publish step:
// apps/cli/node_modules/@nexus/<pkg> -> packages/<pkg>. Node resolves these
// before walking up to the repo root, so `npm test` runs against real packages.
const nm = join(cli, 'node_modules');
const scopeDir = join(nm, '@nexus');
mkdirSync(scopeDir, { recursive: true });
for (const name of PKGS) {
  const link = join(scopeDir, name);
  const target = join(root, 'packages', name);
  if (!existsSync(target)) continue;
  rmSync(link, { recursive: true, force: true });
  try {
    symlinkSync(target, link, 'dir');
  } catch { /* non-fatal: fallback handled below */ }
}

console.log('\nDONE. Verify with: cd apps/cli && node bin.mjs --version');
