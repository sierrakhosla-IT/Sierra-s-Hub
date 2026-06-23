'use strict';

var STORAGE_KEY = 'exec_os_v2_data';
var CURRENT_WORK_LIMIT = 5;

var LANE_LABELS = {
  queue: 'Queue',
  now: 'Current Work',
  waiting: 'Waiting',
  done: 'Done'
};

var state = {
  mission: 'Complete Mobility Reconciliation',
  targets: 'Finish reconciliation\nUpdate inventory',
  tasks: {
    queue: [
      { id: 'q1', text: 'Review vendor contract draft', focused: false },
      { id: 'q2', text: 'Schedule team standup notes', focused: false }
    ],
    now: [
      { id: '1', text: 'Inventory Cleanup', focused: false },
      { id: '2', text: 'Power BI Metrics', focused: true },
      { id: '3', text: 'Unity Review', focused: false }
    ],
    waiting: [
      { id: '4', text: 'Jesus Flores', context: 'FedEx confirmation' },
      { id: '5', text: 'Ben Ludwig', context: 'Manager approval' }
    ],
    done: [
      { id: '6', text: 'Ship Rheannon Phone', timestamp: formatTimestamp(new Date()) }
    ]
  },
  activity: [
    { time: formatTimestamp(new Date()), message: 'System initialized. Ready for execution.' }
  ],
  snapshots: {},
  selectedSnapshotDate: null
};

var draggedTaskId = null;
var draggedSourceLane = null;

function formatTimestamp(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isTypingTarget(el) {
  if (!el) return false;
  var tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function getDefaultState() {
  return JSON.parse(JSON.stringify({
    mission: 'Complete Mobility Reconciliation',
    targets: 'Finish reconciliation\nUpdate inventory',
    tasks: {
      queue: [
        { id: 'q1', text: 'Review vendor contract draft', focused: false },
        { id: 'q2', text: 'Schedule team standup notes', focused: false }
      ],
      now: [
        { id: '1', text: 'Inventory Cleanup', focused: false },
        { id: '2', text: 'Power BI Metrics', focused: true },
        { id: '3', text: 'Unity Review', focused: false }
      ],
      waiting: [
        { id: '4', text: 'Jesus Flores', context: 'FedEx confirmation' },
        { id: '5', text: 'Ben Ludwig', context: 'Manager approval' }
      ],
      done: [
        { id: '6', text: 'Ship Rheannon Phone', timestamp: formatTimestamp(new Date()) }
      ]
    },
    activity: [
      { time: formatTimestamp(new Date()), message: 'System initialized. Ready for execution.' }
    ],
    snapshots: {},
    selectedSnapshotDate: null
  }));
}

function loadFromLocalStorage() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    var parsed = JSON.parse(raw);
    state = Object.assign(getDefaultState(), parsed, {
      tasks: Object.assign(getDefaultState().tasks, parsed.tasks || {}),
      snapshots: parsed.snapshots || {},
      activity: parsed.activity || getDefaultState().activity
    });
    if (!state.tasks.queue) {
      state.tasks.queue = [];
    }
    ['queue', 'now', 'waiting', 'done'].forEach(function (lane) {
      if (!Array.isArray(state.tasks[lane])) {
        state.tasks[lane] = [];
      }
    });
  } catch (err) {
    console.warn('Execution OS: could not load saved state', err);
  }
}

function saveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Execution OS: could not save state', err);
  }
}

function countBlocked() {
  return state.tasks.waiting.filter(function (t) {
    if (!t.context) return false;
    var c = t.context.toLowerCase();
    return c.indexOf('block') !== -1 || c.indexOf('approval') !== -1;
  }).length;
}

function updateMetrics() {
  var queue = state.tasks.queue.length;
  var active = state.tasks.now.length;
  var waiting = state.tasks.waiting.length;
  var done = state.tasks.done.length;
  var blocked = countBlocked();

  document.getElementById('count-active').textContent = active;
  document.getElementById('count-waiting').textContent = waiting;
  document.getElementById('count-done').textContent = done;
  document.getElementById('count-blocked').textContent = blocked;

  var completedSub = document.getElementById('completed-sub');
  if (completedSub) {
    completedSub.textContent = done === 1
      ? '1 task in your Done lane'
      : done + ' tasks in your Done lane';
  }

  document.getElementById('badge-queue').textContent = queue;
  document.getElementById('badge-now').textContent = active;
  document.getElementById('badge-waiting').textContent = waiting;
  document.getElementById('badge-done').textContent = done;

  document.getElementById('mission-sub-counts').textContent =
    queue + ' Queue · ' + active + ' Active · ' + waiting + ' Waiting · ' + done + ' Done';

  updateCurrentWorkCapacity();
}

function updateCurrentWorkCapacity() {
  var count = state.tasks.now.length;
  var over = count > CURRENT_WORK_LIMIT;
  var indicator = document.getElementById('capacity-now');
  var warning = document.getElementById('capacity-warning');
  var lane = document.getElementById('lane-current-work');

  indicator.textContent = count + ' / ' + CURRENT_WORK_LIMIT;
  indicator.classList.toggle('is-over', over);
  warning.hidden = !over;
  lane.classList.toggle('is-over-capacity', over);
}

function logActivity(message) {
  state.activity.unshift({
    time: formatTimestamp(new Date()),
    message: message
  });
  if (state.activity.length > 80) {
    state.activity = state.activity.slice(0, 80);
  }
  renderActivity();
}

function renderActivity() {
  var stream = document.getElementById('timeline-stream');
  stream.innerHTML = '';

  state.activity.forEach(function (entry) {
    var item = document.createElement('div');
    item.className = 'timeline-item entry';

    var time = document.createElement('time');
    time.textContent = entry.time;

    var msg = document.createElement('span');
    msg.textContent = entry.message;

    item.appendChild(time);
    item.appendChild(msg);
    stream.appendChild(item);
  });
}

function buildTaskCard(task, laneKey) {
  var card = document.createElement('div');
  card.className = 'task-card glass' + (task.focused ? ' is-focused' : '');
  card.draggable = true;
  card.dataset.id = task.id;
  card.dataset.lane = laneKey;

  card.addEventListener('dragstart', function (e) {
    if (e.target.isContentEditable && document.activeElement === e.target) {
      e.preventDefault();
      return;
    }
    draggedTaskId = task.id;
    draggedSourceLane = laneKey;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.setData('source-lane', laneKey);
    card.classList.add('is-dragging');
  });

  card.addEventListener('dragend', function () {
    card.classList.remove('is-dragging');
    draggedTaskId = null;
    draggedSourceLane = null;
    document.querySelectorAll('.lane-column').forEach(function (col) {
      col.classList.remove('is-drag-over');
    });
  });

  var deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.setAttribute('aria-label', 'Delete task');
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    deleteTask(laneKey, task.id);
  });

  var main = document.createElement('div');
  main.className = 'task-main';

  if (task.focused && laneKey === 'now') {
    var badge = document.createElement('span');
    badge.className = 'focus-badge';
    badge.textContent = '⭐ Focus Task';
    main.appendChild(badge);
  }

  var text = document.createElement('span');
  text.className = 'task-text';
  text.contentEditable = 'true';
  text.spellcheck = true;
  text.textContent = task.text;
  text.addEventListener('focus', function () {
    card.draggable = false;
  });
  text.addEventListener('blur', function () {
    card.draggable = true;
    updateTaskText(laneKey, task.id, text.innerText.trim());
  });
  text.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      text.blur();
    }
  });
  main.appendChild(text);

  card.appendChild(deleteBtn);
  card.appendChild(main);

  if (laneKey === 'waiting') {
    var ctx = document.createElement('div');
    ctx.className = 'task-context';
    ctx.contentEditable = 'true';
    ctx.spellcheck = true;
    ctx.textContent = task.context || '';
    ctx.addEventListener('focus', function () {
      card.draggable = false;
    });
    ctx.addEventListener('blur', function () {
      card.draggable = true;
      updateTaskContext(laneKey, task.id, ctx.innerText.trim());
    });
    card.appendChild(ctx);
  }

  if (laneKey === 'done') {
    var ts = document.createElement('div');
    ts.className = 'task-timestamp';
    ts.textContent = task.timestamp || formatTimestamp(new Date());
    card.appendChild(ts);
  }

  card.addEventListener('dblclick', function (e) {
    if (e.target.isContentEditable) return;
    if (laneKey !== 'now') return;
    setFocusTask(task.id);
  });

  return card;
}

window.updateTaskText = function (lane, id, newText) {
  var task = state.tasks[lane].find(function (t) { return t.id === id; });
  if (!task || task.text === newText) return;
  task.text = newText;
  saveToLocalStorage();
};

window.updateTaskContext = function (lane, id, newContext) {
  var task = state.tasks[lane].find(function (t) { return t.id === id; });
  if (!task || task.context === newContext) return;
  task.context = newContext;
  saveToLocalStorage();
};

function renderLane(laneKey, elementId) {
  var container = document.getElementById(elementId);
  container.innerHTML = '';

  state.tasks[laneKey].forEach(function (task) {
    container.appendChild(buildTaskCard(task, laneKey));
  });
}

function renderBoard() {
  renderLane('queue', 'list-queue');
  renderLane('now', 'list-now');
  renderLane('waiting', 'list-waiting');
  renderLane('done', 'list-done');
  updateMetrics();
  renderSnapshots();
  saveToLocalStorage();
}

function syncMissionFieldsToDOM() {
  document.getElementById('mission-text').textContent = state.mission;

  var list = document.getElementById('mission-targets-list');
  list.innerHTML = '';
  state.targets.split('\n').filter(Boolean).forEach(function (line) {
    var li = document.createElement('li');
    li.textContent = line.replace(/^[\s•\-]+/, '');
    list.appendChild(li);
  });
}

function syncMissionFieldsFromDOM() {
  state.mission = document.getElementById('mission-text').innerText.trim();
  var items = Array.prototype.map.call(
    document.querySelectorAll('#mission-targets-list li'),
    function (li) { return li.innerText.trim(); }
  ).filter(Boolean);
  state.targets = items.join('\n');
}

function renderSnapshots() {
  var row = document.getElementById('snapshot-days');
  row.innerHTML = '';

  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  days.forEach(function (dateKey) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'snapshot-day-btn';
    btn.dataset.date = dateKey;
    btn.setAttribute('role', 'option');

    if (state.snapshots[dateKey]) btn.classList.add('has-data');
    if (state.selectedSnapshotDate === dateKey) btn.classList.add('is-active');

    var label = new Date(dateKey + 'T12:00:00');
    btn.textContent = dateKey === todayKey()
      ? 'Today'
      : label.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    btn.addEventListener('click', function () {
      loadSnapshot(dateKey);
    });

    row.appendChild(btn);
  });

  renderSnapshotPreview();
}

function renderSnapshotPreview() {
  var box = document.getElementById('snapshot-preview');
  box.innerHTML = '';

  if (!state.selectedSnapshotDate || !state.snapshots[state.selectedSnapshotDate]) {
    var ph = document.createElement('span');
    ph.className = 'placeholder-text';
    ph.textContent = state.snapshots[todayKey()]
      ? 'Click a day to load historical snapshot'
      : 'No snapshots yet — Save Today to archive current execution state';
    box.appendChild(ph);
    return;
  }

  var snap = state.snapshots[state.selectedSnapshotDate];
  var lines = [
    'Mission: ' + snap.mission,
    'Queue: ' + (snap.tasks.queue ? snap.tasks.queue.length : 0) +
      ' · Active: ' + snap.tasks.now.length +
      ' · Waiting: ' + snap.tasks.waiting.length +
      ' · Done: ' + snap.tasks.done.length
  ];

  if (snap.archivedDone && snap.archivedDone.length) {
    var totalArchived = snap.archivedDone.reduce(function (sum, batch) {
      return sum + (batch.count || (batch.tasks ? batch.tasks.length : 0));
    }, 0);
    lines.push('Archived completions: ' + totalArchived);
  }

  lines.forEach(function (line) {
    var p = document.createElement('div');
    p.className = 'snapshot-preview-line';
    p.textContent = line;
    box.appendChild(p);
  });
}

function saveSnapshot() {
  var key = todayKey();
  var existing = state.snapshots[key];
  state.snapshots[key] = {
    mission: state.mission,
    targets: state.targets,
    tasks: JSON.parse(JSON.stringify(state.tasks)),
    savedAt: new Date().toISOString(),
    archivedDone: existing && existing.archivedDone ? existing.archivedDone : []
  };
  state.selectedSnapshotDate = key;
  logActivity('Saved daily snapshot for ' + key);
  renderSnapshots();
  saveToLocalStorage();
}

function clearAllBoard() {
  var total = ['queue', 'now', 'waiting', 'done'].reduce(function (sum, lane) {
    return sum + state.tasks[lane].length;
  }, 0);

  if (total === 0) {
    logActivity('Clear All — board already empty');
    return;
  }

  if (!confirm(
    'Clear all tasks from the board? ' + total +
    ' task(s) will be removed. Mission, targets, and saved snapshots are kept.'
  )) {
    return;
  }

  ['queue', 'now', 'waiting', 'done'].forEach(function (lane) {
    state.tasks[lane] = [];
  });

  logActivity('Clear All — removed ' + total + ' task(s)');
  renderBoard();
}

function startNewDay() {
  var doneTasks = state.tasks.done;

  if (doneTasks.length === 0) {
    logActivity('New Day — Done lane already clear');
    return;
  }

  if (!confirm(
    'Start a new day? ' + doneTasks.length +
    ' completed task(s) will be archived to today\'s snapshot and cleared from Done.'
  )) {
    return;
  }

  var key = todayKey();
  var existing = state.snapshots[key];
  var archiveBatch = {
    archivedAt: new Date().toISOString(),
    count: doneTasks.length,
    tasks: JSON.parse(JSON.stringify(doneTasks))
  };

  if (!existing) {
    state.snapshots[key] = {
      mission: state.mission,
      targets: state.targets,
      tasks: JSON.parse(JSON.stringify(state.tasks)),
      savedAt: new Date().toISOString(),
      archivedDone: [archiveBatch]
    };
  } else {
    if (!existing.archivedDone) {
      existing.archivedDone = [];
    }
    existing.archivedDone.push(archiveBatch);
    existing.tasks = JSON.parse(JSON.stringify(state.tasks));
    existing.savedAt = new Date().toISOString();
  }

  state.tasks.done = [];
  state.selectedSnapshotDate = key;
  logActivity('New Day — archived ' + doneTasks.length + ' completed task(s)');
  renderBoard();
}

function loadSnapshot(dateKey) {
  if (!state.snapshots[dateKey]) {
    state.selectedSnapshotDate = dateKey;
    renderSnapshotPreview();
    return;
  }

  if (!confirm('Load snapshot from ' + dateKey + '? Current unsaved work stays until you save again.')) {
    state.selectedSnapshotDate = dateKey;
    renderSnapshotPreview();
    return;
  }

  var snap = state.snapshots[dateKey];
  state.mission = snap.mission;
  state.targets = snap.targets;
  state.tasks = JSON.parse(JSON.stringify(snap.tasks));
  if (!state.tasks.queue) {
    state.tasks.queue = [];
  }
  state.selectedSnapshotDate = dateKey;

  syncMissionFieldsToDOM();
  logActivity('Loaded snapshot from ' + dateKey);
  renderBoard();
}

function addTask(lane, text) {
  var task = { id: uid(), text: text, focused: false };
  state.tasks[lane].push(task);
  logActivity('Added to ' + LANE_LABELS[lane] + ': "' + text + '"');
  renderBoard();
}

function addWaitingTask(raw) {
  var parts = raw.split('—');
  var name = parts[0] ? parts[0].trim() : 'Context';
  var reason = parts[1] ? parts[1].trim() : 'Awaiting updates';

  state.tasks.waiting.push({
    id: uid(),
    text: name,
    context: reason
  });

  logActivity('Added Waiting: ' + name + ' (' + reason + ')');
  renderBoard();
}

function deleteTask(lane, id) {
  var task = state.tasks[lane].find(function (t) { return t.id === id; });
  state.tasks[lane] = state.tasks[lane].filter(function (t) { return t.id !== id; });
  if (task) logActivity('Removed from ' + lane + ': ' + task.text);
  renderBoard();
}

function setFocusTask(id) {
  state.tasks.now.forEach(function (t) {
    t.focused = t.id === id ? !t.focused : false;
  });
  var focused = state.tasks.now.find(function (t) { return t.focused; });
  logActivity(focused ? 'Focus set: ' + focused.text : 'Focus cleared');
  renderBoard();
}

function togglePrimaryFocus() {
  if (state.tasks.now.length === 0) return;
  var current = state.tasks.now.findIndex(function (t) { return t.focused; });
  state.tasks.now.forEach(function (t) { t.focused = false; });
  var nextIndex = current >= 0 ? (current + 1) % state.tasks.now.length : 0;
  state.tasks.now[nextIndex].focused = true;
  logActivity('Focus: ' + state.tasks.now[nextIndex].text);
  renderBoard();
}

function moveTask(sourceLane, targetLane, taskId) {
  if (sourceLane === targetLane) return;

  var idx = state.tasks[sourceLane].findIndex(function (t) { return t.id === taskId; });
  if (idx === -1) return;

  var task = state.tasks[sourceLane].splice(idx, 1)[0];
  task.focused = false;

  if (targetLane === 'done') {
    task.timestamp = formatTimestamp(new Date());
    logActivity('Completed: ' + task.text);
  } else if (targetLane === 'waiting' && !task.context) {
    task.context = 'Awaiting updates';
    logActivity('Moved to Waiting: ' + task.text);
  } else if (targetLane === 'now' && state.tasks.now.length >= CURRENT_WORK_LIMIT) {
    logActivity('Moved to Current Work (over capacity): ' + task.text);
  } else {
    logActivity('Moved to ' + LANE_LABELS[targetLane] + ': ' + task.text);
  }

  state.tasks[targetLane].push(task);
  renderBoard();
}

window.allowDrop = function (e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var col = e.currentTarget;
  if (col && col.classList) col.classList.add('is-drag-over');
};

window.dragLeave = function (e) {
  var col = e.currentTarget;
  if (col && col.contains(e.relatedTarget)) return;
  if (col && col.classList) col.classList.remove('is-drag-over');
};

window.drop = function (e, targetLane) {
  e.preventDefault();
  e.currentTarget.classList.remove('is-drag-over');

  var id = e.dataTransfer.getData('text/plain') || draggedTaskId;
  var sourceLane = e.dataTransfer.getData('source-lane') || draggedSourceLane;
  if (!id || !sourceLane) return;

  moveTask(sourceLane, targetLane, id);
};

function setupEventListeners() {
  document.getElementById('input-queue').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var value = e.target.value.trim();
    if (!value) return;
    e.preventDefault();
    addTask('queue', value);
    e.target.value = '';
  });

  document.getElementById('input-now').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var value = e.target.value.trim();
    if (!value) return;
    e.preventDefault();
    addTask('now', value);
    e.target.value = '';
  });

  document.getElementById('input-waiting').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var value = e.target.value.trim();
    if (!value) return;
    e.preventDefault();
    addWaitingTask(value);
    e.target.value = '';
  });

  document.getElementById('mission-text').addEventListener('blur', function () {
    syncMissionFieldsFromDOM();
    saveToLocalStorage();
  });

  document.getElementById('mission-targets-list').addEventListener('blur', function () {
    syncMissionFieldsFromDOM();
    saveToLocalStorage();
  });

  document.getElementById('snapshot-save-btn').addEventListener('click', saveSnapshot);
  document.getElementById('new-day-btn').addEventListener('click', startNewDay);
  document.getElementById('clear-all-btn').addEventListener('click', clearAllBoard);
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', function (e) {
    if (isTypingTarget(e.target)) return;

    switch (e.key.toLowerCase()) {
      case 'n':
        e.preventDefault();
        document.getElementById('input-queue').focus();
        break;
      case 'w':
        e.preventDefault();
        document.getElementById('input-now').focus();
        break;
      case 'f':
        e.preventDefault();
        togglePrimaryFocus();
        break;
      case '/':
        e.preventDefault();
        document.getElementById('mission-text').focus();
        break;
      case 'd':
        e.preventDefault();
        document.getElementById('list-done').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        break;
      default:
        break;
    }
  });
}

document.addEventListener('DOMContentLoaded', function () {
  loadFromLocalStorage();
  syncMissionFieldsToDOM();
  setupEventListeners();
  setupKeyboardShortcuts();
  renderActivity();
  renderBoard();
});
