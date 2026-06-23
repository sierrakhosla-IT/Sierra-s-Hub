'use strict';

// ─────────────────────────────────────────────────────────
// Execution OS  ·  Version 1.0
// ─────────────────────────────────────────────────────────

const STORAGE_KEY = 'exec_os_v1';
const LEGACY_KEY  = 'ops_dem_v2';

const LANES = ['now', 'next', 'waiting', 'done'];

// ─────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────

let state = emptyState();
let triage = [];           // Captured items pending lane assignment
let selectedId = null;     // Currently inspected task ID
let saveTimer = null;
let movePopoverTaskId = null;

function emptyState() {
  return {
    version: 1,
    dateKey: todayKey(),
    lastDay: '',
    mission: '',
    tasks: { now: [], next: [], waiting: [], done: [] },
    eod: { closedToday: '', tomorrowMission: '', notes: '' }
  };
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2, 9) + Math.random().toString(36).slice(2, 9);
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeTask(text, extra) {
  const ts = Date.now();
  return {
    id: uid(),
    text: (text || '').trim(),
    context: '',
    waitingOn: '',
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
    ...(extra || {})
  };
}

function ensureTask(t) {
  const ts = Date.now();
  if (!t.id)           t.id = uid();
  if (!t.createdAt)    t.createdAt = ts;
  if (!t.updatedAt)    t.updatedAt = t.createdAt;
  if (t.context === undefined) t.context = '';
  if (t.waitingOn === undefined) t.waitingOn = '';
  return t;
}

// Find which lane a task lives in. Returns { lane, idx } or null.
function findTask(id) {
  if (!id) return null;
  for (const lane of LANES) {
    const arr = state.tasks[lane];
    const idx = arr.findIndex(t => t.id === id);
    if (idx >= 0) return { lane, idx, task: arr[idx] };
  }
  return null;
}

// Total active (non-done) tasks count
function activeTotalCount() {
  return state.tasks.now.length + state.tasks.next.length + state.tasks.waiting.length;
}

// ─────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────

function setSaveDot(status) {
  const el = document.getElementById('save-dot');
  if (!el) return;
  el.className = 'save-dot ' + (status || '');
}

function setDockStatus(msg) {
  const el = document.getElementById('dock-status');
  if (el) el.textContent = msg || 'Ready';
}

function save() {
  setSaveDot('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveDot('saved');
      setTimeout(() => setSaveDot(''), 1500);
    } catch (e) {
      setSaveDot('failed');
    }
  }, 450);
}

function normalize(s) {
  const base = emptyState();
  const m = { ...base, ...s };
  m.tasks = {
    now:     ((s.tasks?.now)     || []).map(ensureTask),
    next:    ((s.tasks?.next)    || []).map(ensureTask),
    waiting: ((s.tasks?.waiting) || []).map(ensureTask),
    done:    ((s.tasks?.done)    || []).slice(0, 50).map(ensureTask)
  };
  m.eod = { ...base.eod, ...(s.eod || {}) };
  m.mission = s.mission || '';
  m.lastDay = s.lastDay || '';
  return m;
}

// Migrate from the old Focus Hub state
function migrateFromLegacy(old) {
  const now = [];
  const next = [];
  const waiting = [];
  const done = [];

  // Block 1 Do Now → now
  ((old.blocks?.block1?.donow) || []).forEach(t => {
    if ((t.text || '').trim() && !t.done) {
      now.push(makeTask(t.text, { createdAt: t.createdAt, updatedAt: t.updatedAt }));
    }
  });

  // Everything else that's not done → next
  const nextSources = [
    ...(old.blocks?.block1?.quickhits || []),
    ...(old.blocks?.block2?.donow     || []),
    ...(old.blocks?.block2?.quickhits || []),
    ...(old.blocks?.block3?.items     || []),
    ...(old.quickCapture              || []),
  ];
  nextSources.forEach(t => {
    const text = (t.text || '').trim();
    if (text && !t.done) {
      next.push(makeTask(text, { createdAt: t.createdAt, updatedAt: t.updatedAt }));
    }
  });

  // Follow-ups / parked → waiting
  [...(old.followUps || []), ...(old.parked || [])].forEach(f => {
    const text = (f.sent || f.snow || '').trim();
    if (text) {
      waiting.push(makeTask(text, {
        waitingOn: f.sent || '',
        context: f.reply || ''
      }));
    }
  });

  // Done lane → done
  (old.doneLane || []).forEach(t => {
    if ((t.text || '').trim()) {
      done.push(makeTask(t.text, {
        completedAt: t.completedAt || Date.now(),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      }));
    }
  });

  const mission = (old.targets?.[0]?.text || '').trim();

  return {
    version: 1,
    dateKey: old.dateKey || todayKey(),
    lastDay: old.lastDay || '',
    mission,
    tasks: { now, next, waiting, done },
    eod: {
      closedToday: old.eod?.closedToday || '',
      tomorrowMission: old.eod?.tomorrowT1 || '',
      notes: old.start?.workNotes || ''
    }
  };
}

function loadState() {
  // Try new key first
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) {
        state = normalize(parsed);
        return;
      }
    }
  } catch (e) {}

  // Try to migrate from legacy
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const old = JSON.parse(legacyRaw);
      if (old && old.version === 2) {
        state = normalize(migrateFromLegacy(old));
        save(); // persist migrated state
        toast('Migrated your Focus Hub data');
        return;
      }
    }
  } catch (e) {}

  state = emptyState();
}

// ─────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────

let toastTimer = null;

function toast(msg, duration) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = msg;
  el.classList.add('is-visible');
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), duration || 2800);
}

// ─────────────────────────────────────────────────────────
// Render Helpers
// ─────────────────────────────────────────────────────────

function setEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el && document.activeElement !== el) el.value = value;
}

function fitTextarea(el) {
  if (!el || el.tagName !== 'TEXTAREA') return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function fitAllTextareas() {
  document.querySelectorAll('textarea').forEach(fitTextarea);
}

// ─────────────────────────────────────────────────────────
// Render: Clock & Date
// ─────────────────────────────────────────────────────────

function renderClock() {
  const now = new Date();
  setEl('nav-clock', fmtTime(now));
  setEl('nav-date', fmtDate(now));
}

// ─────────────────────────────────────────────────────────
// Render: Mission
// ─────────────────────────────────────────────────────────

function renderMission() {
  const hero = document.getElementById('section-mission');
  const display = document.getElementById('mission-display');
  const input = document.getElementById('mission-input');

  if (display) {
    if (state.mission) {
      display.textContent = state.mission;
      display.classList.remove('is-empty');
    } else {
      display.textContent = 'What is the one thing that must move today?';
      display.classList.add('is-empty');
    }
  }

  // Update mission echoes
  const echoMission = document.getElementById('echo-mission');
  if (echoMission) {
    echoMission.textContent = state.mission || 'No mission set';
    echoMission.classList.toggle('is-empty', !state.mission);
  }

  const dockMission = document.getElementById('dock-mission');
  if (dockMission) {
    dockMission.textContent = state.mission || 'No mission set';
  }

  // Progress
  const total = activeTotalCount() + state.tasks.done.length;
  const done = state.tasks.done.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const progressWrap = document.getElementById('mission-progress-wrap');
  const progressFill = document.getElementById('mission-progress-fill');
  const progressLabel = document.getElementById('mission-progress-label');

  if (progressWrap) {
    progressWrap.hidden = total === 0;
    if (total > 0) {
      if (progressFill)  progressFill.style.width = pct + '%';
      if (progressLabel) progressLabel.textContent = pct + '% complete';
    }
  }
}

// ─────────────────────────────────────────────────────────
// Render: Left Rail
// ─────────────────────────────────────────────────────────

function renderRail() {
  const counts = {
    now:     state.tasks.now.length,
    next:    state.tasks.next.length,
    waiting: state.tasks.waiting.length,
    done:    state.tasks.done.length
  };

  ['now', 'next', 'waiting', 'done'].forEach(lane => {
    const el = document.getElementById('rnav-' + lane);
    if (!el) return;
    el.textContent = counts[lane];
    el.classList.toggle('has-items', counts[lane] > 0);
  });

  // Update Done section subtitle with count
  const doneSub = document.getElementById('done-sub');
  if (doneSub) {
    const n = counts.done;
    doneSub.textContent = n === 0 ? 'Today' : n + ' completed today';
  }
}

// ─────────────────────────────────────────────────────────
// Render: Task Card HTML
// ─────────────────────────────────────────────────────────

function taskCardHTML(task, lane) {
  ensureTask(task);
  const isDone = lane === 'done';
  const isSelected = selectedId === task.id;
  const text = esc(task.text) || '<em style="opacity:.45">Untitled task</em>';

  const classes = ['task-card'];
  if (isDone)     classes.push('is-done');
  if (isSelected) classes.push('is-selected');

  const waitingLabel = lane === 'waiting' && task.waitingOn
    ? `<span class="task-waiting-label">Waiting on ${esc(task.waitingOn)}</span>`
    : '';

  const actions = isDone ? '' : `
    <div class="task-actions">
      <button type="button" class="task-action-btn btn-move"
        data-action="move" data-task-id="${esc(task.id)}" title="Move to another lane" aria-label="Move task">↕</button>
      <button type="button" class="task-action-btn btn-delete"
        data-action="delete" data-task-id="${esc(task.id)}" title="Delete task" aria-label="Delete task">✕</button>
    </div>`;

  return `
    <div class="${classes.join(' ')}" data-task-id="${esc(task.id)}" data-lane="${esc(lane)}" role="listitem">
      ${isDone
        ? `<span class="task-check is-checked" aria-label="Completed"></span>`
        : `<button type="button" class="task-check"
             data-action="complete" data-task-id="${esc(task.id)}"
             aria-label="Mark complete"></button>`
      }
      <div class="task-content">
        <span class="task-text">${text}</span>
        ${waitingLabel}
      </div>
      ${actions}
    </div>`;
}

// ─────────────────────────────────────────────────────────
// Render: Task Lanes
// ─────────────────────────────────────────────────────────

function renderLane(lane) {
  const list = document.getElementById(lane + '-list');
  if (!list) return;

  const tasks = state.tasks[lane];

  if (!tasks.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = tasks.map(t => taskCardHTML(t, lane)).join('');
}

function renderAllLanes() {
  LANES.forEach(renderLane);
}

// ─────────────────────────────────────────────────────────
// Render: Inspector
// ─────────────────────────────────────────────────────────

function renderInspector() {
  const idle   = document.getElementById('inspector-idle');
  const detail = document.getElementById('inspector-detail');
  if (!idle || !detail) return;

  if (!selectedId) {
    idle.hidden   = false;
    detail.hidden = true;
    return;
  }

  const found = findTask(selectedId);
  if (!found) {
    selectedId = null;
    idle.hidden   = false;
    detail.hidden = true;
    return;
  }

  const { task, lane } = found;
  idle.hidden   = true;
  detail.hidden = false;

  // Badge
  const badge = document.getElementById('inspector-badge');
  if (badge) {
    const labels = { now: 'Now', next: 'Next', waiting: 'Waiting', done: 'Done' };
    badge.textContent = labels[lane] || lane;
    badge.className = 'inspector-lane-badge badge-' + lane;
  }

  // Title
  const titleEl = document.getElementById('inspector-title');
  if (titleEl && document.activeElement !== titleEl) {
    titleEl.value = task.text;
    setTimeout(() => fitTextarea(titleEl), 0);
  }

  // Waiting on
  const waitingGroup = document.getElementById('insp-waiting-group');
  const waitingInput = document.getElementById('inspector-waiting');
  if (waitingGroup) {
    waitingGroup.hidden = lane !== 'waiting';
  }
  if (waitingInput && document.activeElement !== waitingInput) {
    waitingInput.value = task.waitingOn || '';
  }

  // Notes
  const notesEl = document.getElementById('inspector-notes');
  if (notesEl && document.activeElement !== notesEl) {
    notesEl.value = task.context || '';
    setTimeout(() => fitTextarea(notesEl), 0);
  }

  // Meta
  const metaEl = document.getElementById('inspector-meta');
  if (metaEl) {
    const parts = [];
    if (task.createdAt) parts.push('Created ' + fmtRelative(task.createdAt));
    if (task.completedAt) parts.push('Completed ' + fmtRelative(task.completedAt));
    metaEl.textContent = parts.join(' · ');
  }

  // Complete button
  const completeBtn = document.getElementById('btn-insp-complete');
  if (completeBtn) {
    completeBtn.textContent = lane === 'done' ? 'Completed ✓' : 'Mark Complete';
    completeBtn.disabled = lane === 'done';
    completeBtn.style.opacity = lane === 'done' ? '0.5' : '1';
  }

  // Move button
  const moveBtn = document.getElementById('btn-insp-move');
  if (moveBtn) {
    moveBtn.hidden = lane === 'done';
  }
}

// ─────────────────────────────────────────────────────────
// Render: Triage Queue
// ─────────────────────────────────────────────────────────

function renderTriage() {
  const container = document.getElementById('triage-queue');
  if (!container) return;

  if (!triage.length) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = triage.map((item, i) => `
    <div class="triage-item" data-triage-idx="${i}">
      <span class="triage-text">${esc(item.text)}</span>
      <div class="triage-actions">
        <button type="button" class="triage-btn triage-btn-now"
          data-route="${i}" data-lane="now">Now</button>
        <button type="button" class="triage-btn triage-btn-next"
          data-route="${i}" data-lane="next">Next</button>
        <button type="button" class="triage-btn triage-btn-waiting"
          data-route="${i}" data-lane="waiting">Waiting</button>
        <button type="button" class="triage-btn triage-btn-dismiss"
          data-dismiss="${i}" aria-label="Dismiss">✕</button>
      </div>
    </div>`).join('');
}

// ─────────────────────────────────────────────────────────
// Render: EOD Panel
// ─────────────────────────────────────────────────────────

function renderEod() {
  setVal('eod-closed', state.eod.closedToday || '');
  setVal('eod-tomorrow-mission', state.eod.tomorrowMission || '');
  setVal('eod-notes', state.eod.notes || '');
  setTimeout(fitAllTextareas, 10);
}

// ─────────────────────────────────────────────────────────
// Render: All
// ─────────────────────────────────────────────────────────

function renderAll() {
  renderMission();
  renderRail();
  renderAllLanes();
  renderInspector();
  renderDockStatus();
}

function renderDockStatus() {
  const total = activeTotalCount();
  const done  = state.tasks.done.length;
  let msg = 'Ready';
  if (total > 0 || done > 0) {
    msg = total + ' active · ' + done + ' done';
  }
  setDockStatus(msg);
}

// ─────────────────────────────────────────────────────────
// Actions: Mission
// ─────────────────────────────────────────────────────────

function startEditMission() {
  const hero  = document.getElementById('section-mission');
  const input = document.getElementById('mission-input');
  if (!hero || !input) return;
  hero.classList.add('is-editing');
  input.value = state.mission || '';
  input.focus();
  input.select();
  fitTextarea(input);
}

function commitMission() {
  const hero  = document.getElementById('section-mission');
  const input = document.getElementById('mission-input');
  if (!hero || !input) return;
  const val = input.value.trim();
  state.mission = val;
  hero.classList.remove('is-editing');
  renderMission();
  save();
}

// ─────────────────────────────────────────────────────────
// Actions: Capture
// ─────────────────────────────────────────────────────────

// Which lane the capture picker targets
let captureLane = 'next';

function setCaptureLane(lane) {
  captureLane = lane;
  document.querySelectorAll('.clp-btn').forEach(btn => {
    btn.classList.toggle('clp-active', btn.dataset.toLane === lane);
  });
  // Highlight the target section
  document.querySelectorAll('.task-section').forEach(s => s.classList.remove('capture-target'));
  const targetSection = document.getElementById('section-' + lane);
  if (targetSection) targetSection.classList.add('capture-target');
}

function clearCaptureHighlight() {
  document.querySelectorAll('.task-section').forEach(s => s.classList.remove('capture-target'));
}

// Direct capture — zero friction, instant add
function handleCapture() {
  const input = document.getElementById('capture-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  addTaskToLane(captureLane, text);
  input.value = '';

  const laneName = captureLane.charAt(0).toUpperCase() + captureLane.slice(1);
  toast('Added to ' + laneName);

  // Scroll the target section into view
  const section = document.getElementById('section-' + captureLane);
  if (section) {
    setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  }
}

function routeTriageItem(idx, lane) {
  const item = triage[idx];
  if (!item) return;

  const task = makeTask(item.text);
  state.tasks[lane].unshift(task);
  triage.splice(idx, 1);
  selectedId = task.id;

  renderTriage();
  renderAll();
  save();
  toast('Added to ' + lane.charAt(0).toUpperCase() + lane.slice(1));
}

function dismissTriageItem(idx) {
  triage.splice(idx, 1);
  renderTriage();
}

// ─────────────────────────────────────────────────────────
// Actions: Task CRUD
// ─────────────────────────────────────────────────────────

function addTaskToLane(lane, text, extra) {
  const task = makeTask(text, extra);
  state.tasks[lane].unshift(task);
  selectedId = task.id;
  renderAll();
  save();
  return task;
}

function completeTask(id) {
  const found = findTask(id);
  if (!found || found.lane === 'done') return;

  const { task, lane, idx } = found;
  const el = document.querySelector(`[data-task-id="${id}"]`);

  function doComplete() {
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    state.tasks[lane].splice(idx, 1);
    state.tasks.done.unshift(task);
    if (state.tasks.done.length > 50) state.tasks.done = state.tasks.done.slice(0, 50);

    // Update EOD closed today
    if (task.text) {
      const lines = (state.eod.closedToday || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (!lines.includes(task.text)) {
        lines.push(task.text);
        state.eod.closedToday = lines.join('\n');
      }
    }

    // Deselect if this was selected
    if (selectedId === id) selectedId = null;

    renderAll();
    save();
    toast('Task completed');
  }

  if (el) {
    el.classList.add('is-completing');
    setTimeout(doComplete, 220);
  } else {
    doComplete();
  }
}

function deleteTask(id) {
  const found = findTask(id);
  if (!found) return;
  const { lane, idx } = found;

  state.tasks[lane].splice(idx, 1);
  if (selectedId === id) selectedId = null;
  renderAll();
  save();
  toast('Task deleted');
}

function moveTask(id, toLane) {
  const found = findTask(id);
  if (!found || found.lane === toLane) return;

  const { task, lane, idx } = found;
  state.tasks[lane].splice(idx, 1);
  task.updatedAt = Date.now();
  state.tasks[toLane].unshift(task);
  selectedId = id;
  renderAll();
  save();
  toast('Moved to ' + toLane.charAt(0).toUpperCase() + toLane.slice(1));
}

function selectTask(id) {
  selectedId = (selectedId === id) ? null : id;
  renderInspector();
  // Update visual selection on cards
  document.querySelectorAll('.task-card').forEach(card => {
    card.classList.toggle('is-selected', card.dataset.taskId === selectedId);
  });
}

// ─────────────────────────────────────────────────────────
// Actions: Move Popover
// ─────────────────────────────────────────────────────────

function showMovePopover(taskId, anchorEl) {
  // Hide existing
  hideMovePopover();
  movePopoverTaskId = taskId;

  const pop = document.getElementById('move-popover');
  if (!pop) return;

  // Filter out current lane
  const found = findTask(taskId);
  const currentLane = found?.lane;

  pop.querySelectorAll('.move-opt').forEach(btn => {
    btn.hidden = btn.dataset.move === currentLane || btn.dataset.move === 'done';
  });

  const rect = anchorEl.getBoundingClientRect();
  pop.style.top  = (rect.bottom + 6) + 'px';
  pop.style.left = Math.min(rect.left, window.innerWidth - 160) + 'px';
  pop.hidden = false;

  setTimeout(() => {
    document.addEventListener('click', onOutsideClick, { once: true, capture: true });
  }, 10);
}

function hideMovePopover() {
  const pop = document.getElementById('move-popover');
  if (pop) pop.hidden = true;
  movePopoverTaskId = null;
}

function onOutsideClick(e) {
  const pop = document.getElementById('move-popover');
  if (pop && !pop.contains(e.target)) hideMovePopover();
}

// ─────────────────────────────────────────────────────────
// Actions: Day Management
// ─────────────────────────────────────────────────────────

function newDay() {
  if (!confirm('Start a new day?\n\nDone tasks will be archived. Remaining tasks stay active.')) return;

  // Archive: clear done, carry forward next mission
  const tomorrowMission = state.eod.tomorrowMission;

  state.tasks.done = [];
  state.eod.closedToday = '';
  state.eod.notes = '';
  if (tomorrowMission) {
    state.mission = tomorrowMission;
    state.eod.tomorrowMission = '';
  }
  state.lastDay = todayKey();
  state.dateKey = todayKey();
  selectedId = null;
  triage = [];

  renderAll();
  renderTriage();
  save();
  toast('New day started');
}

function prefillEod() {
  // Auto-populate closed today from done tasks
  if (!state.eod.closedToday.trim()) {
    const completed = state.tasks.done.map(t => t.text).filter(Boolean);
    if (completed.length) state.eod.closedToday = completed.join('\n');
  }
  save();
  openEod();
}

// ─────────────────────────────────────────────────────────
// EOD Panel
// ─────────────────────────────────────────────────────────

function openEod() {
  const panel   = document.getElementById('eod-panel');
  const overlay = document.getElementById('eod-overlay');
  if (!panel) return;
  renderEod();
  panel.classList.add('is-open');
  if (overlay) overlay.hidden = false;
}

function closeEod() {
  const panel   = document.getElementById('eod-panel');
  const overlay = document.getElementById('eod-overlay');
  if (!panel) return;
  panel.classList.remove('is-open');
  if (overlay) overlay.hidden = true;
}

function applyEodAndNewDay() {
  // Read latest values
  const closedEl  = document.getElementById('eod-closed');
  const missionEl = document.getElementById('eod-tomorrow-mission');
  const notesEl   = document.getElementById('eod-notes');

  if (closedEl)  state.eod.closedToday      = closedEl.value.trim();
  if (missionEl) state.eod.tomorrowMission   = missionEl.value.trim();
  if (notesEl)   state.eod.notes             = notesEl.value.trim();

  closeEod();
  newDay();
}

function saveAndCloseEod() {
  const closedEl  = document.getElementById('eod-closed');
  const missionEl = document.getElementById('eod-tomorrow-mission');
  const notesEl   = document.getElementById('eod-notes');

  if (closedEl)  state.eod.closedToday    = closedEl.value.trim();
  if (missionEl) state.eod.tomorrowMission = missionEl.value.trim();
  if (notesEl)   state.eod.notes          = notesEl.value.trim();

  save();
  closeEod();
  toast('End of Day saved');
}

// ─────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────

function bindEvents() {

  // ── Keyboard global shortcuts ──
  document.addEventListener('keydown', e => {
    // Ctrl+K (Windows) / ⌘K (Mac) — focus capture
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const inp = document.getElementById('capture-input');
      if (inp) { inp.focus(); inp.select(); }
      return;
    }

    // Escape — close modals/popovers in priority order
    if (e.key === 'Escape') {
      const hero = document.getElementById('section-mission');
      if (hero?.classList.contains('is-editing')) { commitMission(); return; }
      if (!document.getElementById('clear-ws-modal')?.hidden) { closeClearWorkspace(); return; }
      if (document.getElementById('eod-panel')?.classList.contains('is-open')) { closeEod(); return; }
      if (!document.getElementById('move-popover')?.hidden) { hideMovePopover(); return; }
      const captureInput = document.getElementById('capture-input');
      if (document.activeElement === captureInput && captureInput.value) {
        captureInput.value = '';
        return;
      }
      if (selectedId) { selectedId = null; renderInspector(); document.querySelectorAll('.task-card.is-selected').forEach(c => c.classList.remove('is-selected')); }
      return;
    }
  });

  // ── Capture input ──
  const captureInput = document.getElementById('capture-input');
  if (captureInput) {
    captureInput.addEventListener('focus', () => {
      setCaptureLane(captureLane); // refresh highlight on focus
    });

    captureInput.addEventListener('blur', () => {
      clearCaptureHighlight();
    });

    captureInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCapture();
        return;
      }
      // Tab cycles lane picker
      if (e.key === 'Tab' && !e.shiftKey) {
        const laneOrder = ['next', 'now', 'waiting'];
        const ci = laneOrder.indexOf(captureLane);
        setCaptureLane(laneOrder[(ci + 1) % laneOrder.length]);
        e.preventDefault();
        return;
      }
    });
  }

  // Lane picker buttons
  document.querySelectorAll('.clp-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault(); // don't blur capture input
      setCaptureLane(btn.dataset.toLane);
    });
  });

  // Dock capture button
  document.getElementById('dock-capture-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('capture-input');
    if (inp) { inp.focus(); inp.select(); }
  });

  // ── Mission hero — click to edit ──
  document.getElementById('mission-display-wrap')?.addEventListener('click', () => startEditMission());

  const missionInput = document.getElementById('mission-input');
  if (missionInput) {
    missionInput.addEventListener('blur', commitMission);
    missionInput.addEventListener('input', () => fitTextarea(missionInput));
    missionInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitMission(); }
    });
  }

  // ── Rail buttons ──
  document.getElementById('btn-new-day')?.addEventListener('click', newDay);
  document.getElementById('btn-eod')?.addEventListener('click', prefillEod);
  document.getElementById('btn-clear-workspace')?.addEventListener('click', openClearWorkspace);
  document.getElementById('dock-new-day')?.addEventListener('click', newDay);
  document.getElementById('dock-eod')?.addEventListener('click', prefillEod);

  // ── Clear Workspace Modal ──
  document.getElementById('btn-clear-ws-close')?.addEventListener('click', closeClearWorkspace);
  document.getElementById('btn-clear-ws-cancel')?.addEventListener('click', closeClearWorkspace);
  document.getElementById('btn-clear-ws-confirm')?.addEventListener('click', confirmClearWorkspace);
  document.getElementById('clear-ws-overlay')?.addEventListener('click', closeClearWorkspace);

  // ── EOD Panel ──
  document.getElementById('btn-eod-close')?.addEventListener('click', closeEod);
  document.getElementById('eod-overlay')?.addEventListener('click', closeEod);
  document.getElementById('btn-eod-apply')?.addEventListener('click', applyEodAndNewDay);
  document.getElementById('btn-eod-save')?.addEventListener('click', saveAndCloseEod);

  // EOD field changes
  ['eod-closed', 'eod-tomorrow-mission', 'eod-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      if (id === 'eod-closed')           state.eod.closedToday    = el.value;
      if (id === 'eod-tomorrow-mission') state.eod.tomorrowMission = el.value;
      if (id === 'eod-notes')            state.eod.notes          = el.value;
      fitTextarea(el);
      save();
    });
  });

  // ── Inspector fields ──
  const inspTitle   = document.getElementById('inspector-title');
  const inspNotes   = document.getElementById('inspector-notes');
  const inspWaiting = document.getElementById('inspector-waiting');

  inspTitle?.addEventListener('input', () => {
    const found = findTask(selectedId);
    if (!found) return;
    found.task.text = inspTitle.value;
    found.task.updatedAt = Date.now();
    fitTextarea(inspTitle);
    // Sync text into the task card
    const card = document.querySelector(`[data-task-id="${selectedId}"] .task-text`);
    if (card) card.textContent = found.task.text || 'Untitled task';
    save();
  });

  inspNotes?.addEventListener('input', () => {
    const found = findTask(selectedId);
    if (!found) return;
    found.task.context = inspNotes.value;
    found.task.updatedAt = Date.now();
    fitTextarea(inspNotes);
    save();
  });

  inspWaiting?.addEventListener('input', () => {
    const found = findTask(selectedId);
    if (!found) return;
    found.task.waitingOn = inspWaiting.value;
    found.task.updatedAt = Date.now();
    // Update waiting label in card
    const card = document.querySelector(`[data-task-id="${selectedId}"]`);
    if (card) {
      let label = card.querySelector('.task-waiting-label');
      if (inspWaiting.value) {
        if (!label) {
          label = document.createElement('span');
          label.className = 'task-waiting-label';
          card.querySelector('.task-content')?.appendChild(label);
        }
        label.textContent = 'Waiting on ' + inspWaiting.value;
      } else if (label) {
        label.remove();
      }
    }
    save();
  });

  // Inspector action buttons
  document.getElementById('btn-inspector-close')?.addEventListener('click', () => {
    selectedId = null;
    renderInspector();
    document.querySelectorAll('.task-card.is-selected').forEach(c => c.classList.remove('is-selected'));
  });

  document.getElementById('btn-insp-complete')?.addEventListener('click', () => {
    if (selectedId) completeTask(selectedId);
  });

  document.getElementById('btn-insp-delete')?.addEventListener('click', () => {
    if (!selectedId) return;
    const found = findTask(selectedId);
    if (!found) return;
    const preview = (found.task.text || 'this task').slice(0, 40);
    if (confirm('Delete "' + preview + '"?')) deleteTask(selectedId);
  });

  document.getElementById('btn-insp-move')?.addEventListener('click', e => {
    if (selectedId) showMovePopover(selectedId, e.currentTarget);
  });

  // ── Move popover ──
  document.getElementById('move-popover')?.addEventListener('click', e => {
    const btn = e.target.closest('.move-opt');
    if (!btn) return;
    const toLane = btn.dataset.move;
    if (movePopoverTaskId && toLane) {
      moveTask(movePopoverTaskId, toLane);
      hideMovePopover();
    }
  });

  // ── Done section clear ──
  document.getElementById('btn-clear-done')?.addEventListener('click', () => {
    if (!state.tasks.done.length) return;
    if (confirm('Clear all completed tasks?')) {
      state.tasks.done = [];
      if (state.tasks.done.some(t => t.id === selectedId)) selectedId = null;
      renderAll();
      save();
      toast('Done list cleared');
    }
  });

  // ── Delegated click handler ──
  document.addEventListener('click', e => {
    // Triage routing
    const routeBtn = e.target.closest('[data-route]');
    if (routeBtn) {
      routeTriageItem(+routeBtn.dataset.route, routeBtn.dataset.lane);
      return;
    }

    // Triage dismiss
    const dismissBtn = e.target.closest('[data-dismiss]');
    if (dismissBtn) {
      dismissTriageItem(+dismissBtn.dataset.dismiss);
      return;
    }

    // Task action buttons (complete / move / delete)
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const id = actionBtn.dataset.taskId;
      const action = actionBtn.dataset.action;
      if (action === 'complete') { completeTask(id); return; }
      if (action === 'delete')   { deleteTask(id);  return; }
      if (action === 'move')     { showMovePopover(id, actionBtn); return; }
    }

    // Task card click → select / inspect
    const card = e.target.closest('.task-card');
    if (card && !e.target.closest('[data-action]') && !e.target.closest('button')) {
      selectTask(card.dataset.taskId);
      return;
    }
  });

  // ── Window resize ──
  window.addEventListener('resize', () => {
    fitAllTextareas();
  });
}

// ─────────────────────────────────────────────────────────
// Inspector Collapse
// ─────────────────────────────────────────────────────────

const INSP_COLLAPSED_KEY = 'exec_os_insp_collapsed';

function initInspectorToggle() {
  const inspector = document.getElementById('inspector');
  const btn       = document.getElementById('btn-inspector-toggle');
  if (!inspector || !btn) return;

  if (localStorage.getItem(INSP_COLLAPSED_KEY) === '1') {
    inspector.classList.add('is-collapsed');
    btn.setAttribute('aria-label', 'Expand inspector panel');
  }

  btn.addEventListener('click', () => {
    inspector.classList.toggle('is-collapsed');
    const collapsed = inspector.classList.contains('is-collapsed');
    localStorage.setItem(INSP_COLLAPSED_KEY, collapsed ? '1' : '0');
    btn.setAttribute('aria-label', collapsed ? 'Expand inspector panel' : 'Collapse inspector panel');
  });
}

// ─────────────────────────────────────────────────────────
// Clear Workspace Modal
// ─────────────────────────────────────────────────────────

function openClearWorkspace() {
  document.querySelectorAll('.modal-check').forEach(cb => { cb.checked = false; });
  const overlay = document.getElementById('clear-ws-overlay');
  const modal   = document.getElementById('clear-ws-modal');
  if (overlay) overlay.hidden = false;
  if (modal)   modal.hidden   = false;
}

function closeClearWorkspace() {
  const overlay = document.getElementById('clear-ws-overlay');
  const modal   = document.getElementById('clear-ws-modal');
  if (overlay) overlay.hidden = true;
  if (modal)   modal.hidden   = true;
}

function confirmClearWorkspace() {
  const checked = [...document.querySelectorAll('.modal-check:checked')].map(cb => cb.value);
  if (!checked.length) { closeClearWorkspace(); return; }

  checked.forEach(lane => {
    if (!state.tasks[lane]) return;
    if (selectedId && state.tasks[lane].some(t => t.id === selectedId)) selectedId = null;
    state.tasks[lane] = [];
  });

  closeClearWorkspace();
  renderAll();
  save();

  const label = checked.map(l => l.charAt(0).toUpperCase() + l.slice(1)).join(', ');
  toast('Cleared: ' + label);
}

// ─────────────────────────────────────────────────────────
// Clock Tick
// ─────────────────────────────────────────────────────────

function startClock() {
  renderClock();
  // Align to next minute boundary
  const now = new Date();
  const msToNext = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    renderClock();
    setInterval(renderClock, 60000);
  }, msToNext);
}

// ─────────────────────────────────────────────────────────
// Rail nav — scroll-based active state
// ─────────────────────────────────────────────────────────

function bindRailNav() {
  document.querySelectorAll('.rail-nav-item').forEach(item => {
    item.addEventListener('click', e => {
      const section = document.getElementById('section-' + item.dataset.nav);
      if (section) {
        e.preventDefault();
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Workspace tabs — no-op for disabled
  document.querySelectorAll('.ws-tab.is-disabled').forEach(tab => {
    tab.addEventListener('click', e => { e.preventDefault(); toast('Coming soon'); });
  });
}

// ─────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────

function init() {
  loadState();
  bindEvents();
  bindRailNav();
  initInspectorToggle();
  startClock();

  // Render
  renderAll();

  // Notify if new calendar day
  if (state.lastDay && state.lastDay !== todayKey()) {
    setTimeout(() => toast('New day — use "New Day" when you\'re ready to begin'), 800);
  }

  // Fit all textareas after render
  setTimeout(fitAllTextareas, 50);

  // Set capture lane picker default visual
  setCaptureLane('next');
}

init();
