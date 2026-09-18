// NEXUS dashboard client — vanilla JS, zero deps.
// Subscribes to /events SSE and renders agent/task activity in real time.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const agents = new Map(); // id → {id, role, lastSeen}
  const tasks = new Map();  // id → {id, summary, status}
  const events = [];

  const conn = $('conn');

  function setConnected(yes) {
    conn.textContent = yes ? 'connected' : 'reconnecting…';
    conn.parentNode.classList.toggle('online', yes);
    conn.parentNode.classList.toggle('offline', !yes);
  }

  function renderAgents() {
    const ul = $('agents');
    if (agents.size === 0) { ul.innerHTML = '<li class="empty">No agents yet</li>'; return; }
    ul.innerHTML = '';
    for (const a of agents.values()) {
      const li = document.createElement('li');
      li.textContent = a.id + (a.role ? ` (${a.role})` : '');
      ul.appendChild(li);
    }
  }

  function renderTasks() {
    const ul = $('tasks');
    if (tasks.size === 0) { ul.innerHTML = '<li class="empty">No tasks yet</li>'; return; }
    ul.innerHTML = '';
    for (const t of tasks.values()) {
      const li = document.createElement('li');
      li.className = 'task ' + (t.status || 'pending');
      li.textContent = `${t.id} — ${t.summary || ''}`;
      ul.appendChild(li);
    }
  }

  function renderEvents() {
    const ul = $('events');
    if (events.length === 0) { ul.innerHTML = '<li class="empty">Awaiting stream…</li>'; return; }
    ul.innerHTML = '';
    for (const e of events.slice(-30)) {
      const li = document.createElement('li');
      li.className = 'event kind-' + (e.kind || e.event || 'msg');
      li.textContent = `[${new Date(e.ts || Date.now()).toLocaleTimeString()}] ${e.kind || e.event || 'msg'}: ${JSON.stringify(e).slice(0, 200)}`;
      ul.appendChild(li);
    }
  }

  function handle(ev) {
    const kind = ev.kind || ev.event || 'msg';
    if (kind === 'agent.registered' || kind === 'agent') {
      const id = ev.id || ev.agentId;
      if (id) agents.set(id, { id, role: ev.role || '', lastSeen: Date.now() });
      renderAgents();
    } else if (kind === 'task.started') {
      const id = ev.id || ev.taskId;
      if (id) tasks.set(id, { id, summary: ev.summary || ev.task || '', status: 'running' });
      renderTasks();
    } else if (kind === 'task.ended') {
      const id = ev.id || ev.taskId;
      if (id && tasks.has(id)) tasks.get(id).status = ev.ok === false ? 'failed' : 'done';
      renderTasks();
    }
    events.push(ev);
    renderEvents();
  }

  function connect() {
    const es = new EventSource('/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('message', (e) => { try { handle(JSON.parse(e.data)); } catch {} });
    // also catch named events
    ['agent.registered','agent','task.started','task.ended','task.failed'].forEach((name) => {
      es.addEventListener(name, (e) => { try { handle(JSON.parse(e.data)); } catch {} });
    });
  }

  connect();
})();
