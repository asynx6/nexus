// NEXUS replay UI — vanilla JS, zero deps. Streams /api/events with SSE when
// "follow" is on; otherwise polls. Renders a timeline + detail panel.
//
// Filter inputs:
//   subject     -> EventStore.replay({ subject }) — primary entity id
//   name        -> EventStore.replay({ name })    — event name like "agent.started"
//   limit       -> max events to render at once
//
// Server contract (see replay-server.js):
//   GET /api/events?subject=&name=&since=&limit=&follow=1
//     follow=0 -> JSON array (one-shot)
//     follow=1 -> text/event-stream (each event is `data: {...}\n\n`)
const $ = (id) => document.getElementById(id);

const state = {
  subject: '',
  name: '',
  limit: 500,
  follow: true,
  cursor: 0,
  events: [],     // newest last; rendered in seq order
  selectedSeq: null,
  es: null,
  pollTimer: null,
};

function fmtTs(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function setDot(live) {
  const dot = $('dot');
  dot.classList.toggle('live', !!live);
  dot.title = live ? 'live (SSE connected)' : 'idle';
}

function renderTimeline() {
  const host = $('timeline');
  if (state.events.length === 0) {
    host.innerHTML = '<div class="empty">no events — pick a filter or wait for live data</div>';
    return;
  }
  const rows = state.events.map((e) => {
    const sel = e.seq === state.selectedSeq ? ' selected' : '';
    const subj = e.subject == null ? '<span style="color:var(--muted)">—</span>' : escapeHtml(e.subject);
    return `<div class="row${sel}" data-seq="${e.seq}">`
      + `<span class="seq">${e.seq}</span>`
      + `<span class="ts">${fmtTs(e.ts)}</span>`
      + `<span class="name">${escapeHtml(e.name ?? '')}</span>`
      + `<span class="subject">${subj}</span>`
      + '</div>';
  }).join('');
  host.innerHTML = rows;
  $('count').textContent = `${state.events.length} event${state.events.length === 1 ? '' : 's'}`;
  // keep selected row in view
  if (state.selectedSeq != null) {
    const el = host.querySelector(`.row[data-seq="${state.selectedSeq}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
}

function renderDetail() {
  const body = $('detail-body');
  const ev = state.events.find((e) => e.seq === state.selectedSeq);
  if (!ev) { body.innerHTML = '<span style="color:var(--muted)">click an event to inspect</span>'; return; }
  const kv = [
    ['seq', ev.seq],
    ['id', ev.id],
    ['ts', ev.ts],
    ['name', ev.name],
    ['subject', ev.subject ?? '—'],
  ];
  body.innerHTML = '<div class="kv">' + kv.map(([k, v]) =>
    `<div class="k">${escapeHtml(k)}</div><div>${escapeHtml(String(v))}</div>`
  ).join('') + '</div>'
    + '<h2>data</h2>'
    + `<pre class="json">${escapeHtml(JSON.stringify(ev.data ?? {}, null, 2))}</pre>`
    + '<h2>raw envelope</h2>'
    + `<pre class="json">${escapeHtml(JSON.stringify(ev, null, 2))}</pre>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pushEvent(env) {
  if (!env || typeof env.seq !== 'number') return;
  // de-dup by seq (replays can overlap if filter changes mid-stream)
  if (state.events.length && state.events[state.events.length - 1].seq >= env.seq && state.events.some((e) => e.seq === env.seq)) return;
  if (state.events.length && state.events[state.events.length - 1].seq >= env.seq) {
    // older event arrived after newer — drop (out-of-order)
    return;
  }
  state.events.push(env);
  if (state.events.length > state.limit) state.events.splice(0, state.events.length - state.limit);
  state.cursor = Math.max(state.cursor, env.seq + 1);
  renderTimeline();
}

function buildQuery(extra = {}) {
  const q = new URLSearchParams();
  if (state.subject) q.set('subject', state.subject);
  if (state.name) q.set('name', state.name);
  q.set('limit', String(state.limit));
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

async function refreshOneShot() {
  // one-shot JSON load (used when follow is off or on filter apply)
  try {
    const r = await fetch('/api/events?' + buildQuery());
    if (!r.ok) throw new Error('http ' + r.status);
    const arr = await r.json();
    state.events = Array.isArray(arr) ? arr.slice(-state.limit) : [];
    state.cursor = state.events.length ? state.events[state.events.length - 1].seq + 1 : 0;
    renderTimeline();
  } catch (e) {
    $('timeline').innerHTML = `<div class="empty">load failed: ${escapeHtml(e.message)}</div>`;
  }
}

function startStream() {
  stopStream();
  if (!state.follow) { setDot(false); refreshOneShot(); return; }
  const url = '/api/events?' + buildQuery({ follow: '1', since: String(state.cursor) });
  const es = new EventSource(url);
  state.es = es;
  setDot(false);
  es.onopen = () => setDot(true);
  es.onerror = () => setDot(false);
  es.onmessage = (msg) => {
    if (!msg.data) return;
    try { pushEvent(JSON.parse(msg.data)); } catch { /* ignore parse */ }
  };
}

function stopStream() {
  if (state.es) { try { state.es.close(); } catch {} state.es = null; }
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  setDot(false);
}

function applyFilters() {
  state.subject = $('f-subject').value.trim();
  state.name = $('f-name').value.trim();
  const n = Number($('f-limit').value);
  state.limit = Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 500;
  state.events = [];
  state.cursor = 0;
  state.selectedSeq = null;
  renderTimeline();
  renderDetail();
  startStream();
}

function init() {
  $('apply').addEventListener('click', applyFilters);
  $('clear').addEventListener('click', () => {
    $('f-subject').value = '';
    $('f-name').value = '';
    $('f-limit').value = '500';
    applyFilters();
  });
  $('follow').addEventListener('change', () => {
    state.follow = $('follow').checked;
    startStream();
  });
  $('timeline').addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const seq = Number(row.getAttribute('data-seq'));
    if (Number.isFinite(seq)) { state.selectedSeq = seq; renderTimeline(); renderDetail(); }
  });
  // submit on Enter inside filter inputs
  for (const id of ['f-subject', 'f-name', 'f-limit']) {
    $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyFilters(); });
  }
  startStream();
}

init();
