// `nexus webhooks` — manage event subscriptions (TASK-LEONARS-D2).
// Talks to the control plane REST surface mounted by apps/api.
//
//   nexus webhooks list                     list registrations
//   nexus webhooks add <url> [--events=a,b] [--secret=S] [--desc=...]
//   nexus webhooks get <id>
//   nexus webhooks pause <id> / resume <id>
//   nexus webhooks rm <id>
//   nexus webhooks test <id>                emit a synthetic webhook.test event
//
// Base URL + token come from env (NEXUS_API_BASE / NEXUS_API_TOKEN), so the
// CLI talks to a remote control plane, not a local store.

const BASE_ENV = 'NEXUS_API_BASE';
const TOKEN_ENV = 'NEXUS_API_TOKEN';

export const WEBHOOKS_HELP = `nexus webhooks <subcommand>      manage event subscriptions (control plane REST)
  list                                list registrations
  add <url> [--events=a,b] [--secret=S] [--desc=T]
  get <id>                            show one registration
  pause <id> | resume <id>            stop/resume delivery
  rm <id>                             delete a registration
  test <id>                           emit a synthetic webhook.test event
Env:
  ${BASE_ENV}       control plane base url (e.g. http://localhost:4000)
  ${TOKEN_ENV}      bearer token when the control plane requires auth`;

function fail(stderr, msg, code = 2) { stderr(msg); return code; }

/**
 * Run the webhooks subcommand.
 * @param {string[]} argv args after `webhooks`
 * @param {object} env process.env (injected for tests)
 * @param {(s: string) => void} stdout
 * @param {(s: string) => void} stderr
 * @param {object} [fetchImpl] injected transport for tests
 * @returns {Promise<number>}
 */
export async function runWebhooks(argv, env, stdout, stderr, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const sub = argv[0] ?? 'list';
  const args = argv.slice(1);

  const base = (env[BASE_ENV] ?? '').replace(/\/+$/, '');
  if (!base) return fail(stderr, `webhooks: ${BASE_ENV} is not set.\n\n${WEBHOOKS_HELP}`);

  const headers = { 'content-type': 'application/json' };
  if (env[TOKEN_ENV]) headers.authorization = `Bearer ${env[TOKEN_ENV]}`;

  async function req(method, path, body) {
    const res = await doFetch(base + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json error page */ }
    return { status: res.status, json, text };
  }

  const positional = [];
  const flags = {};
  for (const a of args) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }

  if (sub === 'list') {
    const r = await req('GET', '/webhooks');
    if (r.status !== 200) return fail(stderr, `webhooks list: ${r.status} ${r.text}`);
    const list = r.json.webhooks ?? [];
    if (!list.length) { stdout('no webhooks registered (add one: nexus webhooks add <url>)'); return 0; }
    for (const w of list) stdout(`${w.id}  ${w.url}  events=${w.events === null ? '*' : w.events.join(',')}  delivered=${w.delivered} failed=${w.failed}${w.paused ? '  PAUSED' : ''}`);
    return 0;
  }

  if (sub === 'add') {
    const url = positional[0];
    if (!url) return fail(stderr, 'webhooks add: url required');
    const events = flags.events ? String(flags.events).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const r = await req('POST', '/webhooks', { url, events, secret: flags.secret ?? null, description: flags.desc ?? null });
    if (r.status !== 201) return fail(stderr, `webhooks add: ${r.status} ${r.text}`);
    stdout(`registered ${r.json.id} -> ${r.json.url}${events ? ` (events: ${events.join(', ')})` : ' (all events)'}`);
    return 0;
  }

  if (sub === 'get') {
    const id = positional[0];
    if (!id) return fail(stderr, 'webhooks get: id required');
    const r = await req('GET', '/webhooks/' + id);
    if (r.status === 404) return fail(stderr, `webhooks get: ${id} not found`, 1);
    if (r.status !== 200) return fail(stderr, `webhooks get: ${r.status} ${r.text}`);
    const w = r.json;
    stdout(`${w.id}  ${w.url}`);
    stdout(`  events:     ${w.events === null ? '(all)' : w.events.join(', ')}`);
    stdout(`  delivered:  ${w.delivered}   failed: ${w.failed}   lastStatus: ${w.lastStatus ?? '-'}`);
    if (w.lastError) stdout(`  lastError:  ${w.lastError}`);
    if (w.description) stdout(`  description: ${w.description}`);
    return 0;
  }

  if (sub === 'pause' || sub === 'resume') {
    const id = positional[0];
    if (!id) return fail(stderr, `webhooks ${sub}: id required`);
    const r = await req('PATCH', '/webhooks/' + id, { paused: sub === 'pause' });
    if (r.status === 404) return fail(stderr, `webhooks ${sub}: ${id} not found`, 1);
    if (r.status !== 200) return fail(stderr, `webhooks ${sub}: ${r.status} ${r.text}`);
    stdout(`${sub === 'pause' ? 'paused' : 'resumed'} ${r.json.id}`);
    return 0;
  }

  if (sub === 'rm') {
    const id = positional[0];
    if (!id) return fail(stderr, 'webhooks rm: id required');
    const r = await req('DELETE', '/webhooks/' + id);
    if (r.status === 404) return fail(stderr, `webhooks rm: ${id} not found`, 1);
    if (r.status !== 204) return fail(stderr, `webhooks rm: ${r.status} ${r.text}`);
    stdout(`removed ${id}`);
    return 0;
  }

  if (sub === 'test') {
    const id = positional[0];
    if (!id) return fail(stderr, 'webhooks test: id required');
    const r = await req('POST', '/webhooks/' + id + '/test');
    if (r.status === 404) return fail(stderr, `webhooks test: ${id} not found`, 1);
    if (r.status !== 202) return fail(stderr, `webhooks test: ${r.status} ${r.text}`);
    stdout(`sent test event ${r.json.eventId} to ${id}`);
    return 0;
  }

  return fail(stderr, `webhooks: unknown subcommand "${sub}"\n\n${WEBHOOKS_HELP}`);
}
