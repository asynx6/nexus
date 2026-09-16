// Minimal level logger with timestamps. JSON one-line in production mode.
export function makeLogger(scope, { level = process.env.NEXUS_LOG || 'info', json = false } = {}) {
  const L = { debug: 0, info: 1, warn: 2, error: 3 };
  const emit = (lvl, msg, extra) => {
    if (L[lvl] < L[level]) return;
    if (json) {
      console.log(JSON.stringify({ t: new Date().toISOString(), lvl, scope, msg, ...extra }));
      return;
    }
    const suffix = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
    console.log(`${new Date().toISOString().slice(11, 23)} ${lvl.toUpperCase()} [${scope}] ${msg}${suffix}`);
  };
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}
