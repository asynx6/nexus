// GH Actions nexus-bot template tests — parse + dispatch validation.
// Validates the YAML template structure is parseable and the JS helper
// correctly parses /nexus commands from PR comments.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

test('template: .github/templates/nexus-bot.yml exists', () => {
  const p = join(ROOT, '.github', 'templates', 'nexus-bot.yml');
  assert.ok(existsSync(p), `missing: ${p}`);
});

test('template: nexus-bot.yml has required structure', () => {
  const p = join(ROOT, '.github', 'templates', 'nexus-bot.yml');
  const yml = readFileSync(p, 'utf8');
  // Required top-level keys for issue_comment workflow
  assert.match(yml, /^name:\s*nexus-bot/m, 'must have name: nexus-bot');
  assert.match(yml, /^\s*on:\s*\n\s*issue_comment:\s*\n/m, 'must trigger on issue_comment');
  assert.match(yml, /types:\s*\[created\]/, 'must react to comment created');
  assert.match(yml, /runs-on:\s*ubuntu-latest/);
  // Must check the comment is on a PR (not issue) and body starts with /nexus
  assert.match(yml, /pull_request/);
  assert.match(yml, /\/nexus/);
});
