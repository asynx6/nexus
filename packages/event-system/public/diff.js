// NEXUS replay UI — run diff (TASK-LEONARS-B3).
// Loads /api/subjects into two pickers, then renders the aligned diff
// between the selected runs in place of the plain timeline. Zero deps.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtVal(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  function fill(select, subjects, skip) {
    const prev = select.value;
    select.innerHTML = '<option value="">— select run —</option>';
    for (const s of subjects) {
      if (s.subject === skip) continue;
      const o = document.createElement('option');
      o.value = s.subject;
      o.textContent = `${s.subject} (${s.count})`;
      select.appendChild(o);
    }
    if (prev && subjects.some((s) => s.subject === prev)) select.value = prev;
  }

  async function loadSubjects() {
    try {
      const r = await fetch('/api/subjects');
      if (!r.ok) return [];
      const arr = await r.json();
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function renderDiff(payload) {
    const host = $('timeline');
    const s = payload.summary;
    $('d-summary').textContent = `events ${payload.ops.length ? '' : ''}same ${s.same} · modified ${s.mod} · added ${s.added} · removed ${s.removed}`;
    if (s.identical) {
      host.innerHTML = '<div class="empty">identical: both runs produced the same event spine and payloads</div>';
      return;
    }
    host.innerHTML = '';
    for (const op of payload.ops) {
      if (op.op === 'same') continue;
      const div = document.createElement('div');
      if (op.op === 'added') {
        div.className = 'diffop added';
        div.innerHTML = `<span class="tag">+</span>${esc(op.b.name)} <span class="delta">only in ${esc(payload.right)}</span>
          <div class="delta">${esc(JSON.stringify(op.b.data ?? {}))}</div>`;
      } else if (op.op === 'removed') {
        div.className = 'diffop removed';
        div.innerHTML = `<span class="tag">−</span>${esc(op.a.name)} <span class="delta">only in ${esc(payload.left)}</span>
          <div class="delta">${esc(JSON.stringify(op.a.data ?? {}))}</div>`;
      } else {
        const changes = op.changes.map((c) => `${esc(c.field)}: ${esc(fmtVal(c.from))} → ${esc(fmtVal(c.to))}`).join('<br>');
        div.className = 'diffop modified';
        div.innerHTML = `<span class="tag">~</span>${esc(op.a.name)}<div class="delta">${changes}</div>`;
      }
      host.appendChild(div);
    }
    if (host.children.length === 0) host.innerHTML = '<div class="empty">diff produced no changes</div>';
  }

  async function compare() {
    const left = $('d-left').value;
    const right = $('d-right').value;
    if (!left || !right) { $('d-summary').textContent = 'pick two runs'; return; }
    $('d-summary').textContent = 'computing…';
    try {
      const r = await fetch(`/api/diff?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
      const payload = await r.json();
      if (!r.ok) { $('d-summary').textContent = ''; $('timeline').innerHTML = `<div class="empty">${esc(payload.error || 'http ' + r.status)}</div>`; return; }
      renderDiff(payload);
    } catch (e) {
      $('d-summary').textContent = '';
      $('timeline').innerHTML = `<div class="empty">diff failed: ${esc(e.message)}</div>`;
    }
  }

  async function init() {
    const subjects = await loadSubjects();
    fill($('d-left'), subjects, null);
    fill($('d-right'), subjects, null);
    if (subjects.length >= 2) {
      $('d-left').value = subjects[0].subject;
      $('d-right').value = subjects[1].subject;
    }
    $('d-compare').addEventListener('click', compare);
  }

  init();
})();
