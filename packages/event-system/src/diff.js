// Replay diff: structural comparison of two event sequences (subjects/runs).
//
// Two runs of the same task should produce the same event spine; the diff
// aligns the two sequences by (name, keyed data) with an LCS pass and reports
// what changed. Alignment is by event identity, not raw JSON: two
// agent.tool_called events for fs.read are the "same" step, so a changed
// result shows as one modified event, not one removal + one addition.
//
// Output is a flat list of ops consumed by the CLI and the replay UI:
//   { op:'same',  a, b }           matched, payloads equal
//   { op:'mod',   a, b, changes }  matched, payload fields differ
//   { op:'added', b }              present only in the right sequence
//   { op:'removed', a }            present only in the left sequence
//
// ponytail: events with no identity key (see keyFor) align by name+offset,
// which is noisy on reordered runs — acceptable; add a stable identity field
// to the event data when that matters.

/** Fields that never identify a step — outcome/timing, exactly what we diff. */
const NON_IDENTITY = new Set([
  'id', 'ts', 'seq',
  'ok', 'success', 'error', 'errorText', 'errorMessage', 'errno', 'code',
  'result', 'results', 'output', 'stdout', 'stderr', 'exitCode', 'status',
  'durationMs', 'ms', 'took', 'elapsedMs', 'startedAt', 'finishedAt', 'at',
]);

/**
 * Identity of an event within a run: name + the subset of data that pins the
 * step (e.g. tool name, file path, command), ignoring volatile outcome fields.
 * Returns just the name when no identity fields exist (alignment by offset).
 */
export function keyFor(event) {
  const data = event.data ?? {};
  const keys = Object.keys(data).filter((k) => !NON_IDENTITY.has(k));
  if (keys.length === 0) return event.name;
  const parts = keys.sort().map((k) => `${k}=${stable(data[k])}`);
  return `${event.name}|${parts.join('|')}`;
}

/** Deterministic, order-independent stringification for identity comparison. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
}

/** Deep-equal on JSON-ish values (order-independent for objects). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * Field-level change list between two event payloads.
 * @returns {{ field: string, from: *, to: *}[]} empty when identical
 */
export function diffPayload(a, b) {
  const da = a.data ?? {}, db = b.data ?? {};
  const fields = new Set([...Object.keys(da), ...Object.keys(db)]);
  const out = [];
  for (const f of [...fields].sort()) {
    if (!deepEqual(da[f], db[f])) out.push({ field: f, from: da[f] ?? undefined, to: db[f] ?? undefined });
  }
  return out;
}

/**
 * Align two event sequences and produce the diff op list (in order).
 *
 * @param {object[]} left  events of run A (seq order)
 * @param {object[]} right events of run B (seq order)
 * @returns {object[]} ops, each with op + a/b event (+ changes for 'mod')
 */
export function diffRuns(left = [], right = []) {
  const la = Array.isArray(left) ? left : [];
  const rb = Array.isArray(right) ? right : [];

  // LCS over identity keys. Runs share a spine; LCS is the right shape here.
  const ka = la.map(keyFor), kb = rb.map(keyFor);
  const n = ka.length, m = kb.length;
  // dp[i][j] = length of LCS of ka[i:] and kb[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (dp[i][j] === dp[i + 1][j + 1] + 1 && ka[i] === kb[j]) {
      const changes = diffPayload(la[i], rb[j]);
      ops.push(changes.length === 0 ? { op: 'same', a: la[i], b: rb[j] } : { op: 'mod', a: la[i], b: rb[j], changes });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'removed', a: la[i] });
      i++;
    } else {
      ops.push({ op: 'added', b: rb[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: 'removed', a: la[i++] });
  while (j < m) ops.push({ op: 'added', b: rb[j++] });
  return ops;
}

/** Summary counts for a diff op list. */
export function summarize(ops) {
  const s = { same: 0, mod: 0, added: 0, removed: 0 };
  for (const op of ops) s[op.op] += 1;
  s.total = ops.length;
  s.identical = s.mod === 0 && s.added === 0 && s.removed === 0;
  return s;
}
