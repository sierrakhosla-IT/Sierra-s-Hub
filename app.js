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
      { id: '4', text: 'Jesus Flores', context: 'FedEx confirmation', waitingSince: Date.now() - 2 * 24 * 60 * 60 * 1000 },
      { id: '5', text: 'Ben Ludwig', context: 'Manager approval', waitingSince: Date.now() - 5 * 60 * 60 * 1000 }
    ],
    done: [
      { id: '6', text: 'Ship Rheannon Phone', timestamp: formatTimestamp(new Date()) }
    ]
  },
  activity: [
    { time: formatTimestamp(new Date()), message: 'System initialized. Ready for execution.', type: 'system' }
  ],
  snapshots: {},
  selectedSnapshotDate: null,
  totalFocusMs: 0,
  focusSessionStart: null,
  dailyStats: { date: null, started: 0, completed: 0 }
};

var draggedTaskId = null;
var draggedSourceLane = null;

function formatTimestamp(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatWaitingAge(ts) {
  if (!ts) return '';
  var diff = Date.now() - ts;
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins === 1 ? '1 min' : mins + ' mins';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? '1 hour' : hrs + ' hours';
  var days = Math.floor(hrs / 24);
  return days === 1 ? '1 day' : days + ' days';
}

function backfillWaitingSince() {
  state.tasks.waiting.forEach(function (task) {
    if (!task.waitingSince) {
      task.waitingSince = Date.now();
    }
  });
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
        { id: '4', text: 'Jesus Flores', context: 'FedEx confirmation', waitingSince: Date.now() - 2 * 24 * 60 * 60 * 1000 },
        { id: '5', text: 'Ben Ludwig', context: 'Manager approval', waitingSince: Date.now() - 5 * 60 * 60 * 1000 }
      ],
      done: [
        { id: '6', text: 'Ship Rheannon Phone', timestamp: formatTimestamp(new Date()) }
      ]
    },
    activity: [
      { time: formatTimestamp(new Date()), message: 'System initialized. Ready for execution.', type: 'system' }
    ],
    snapshots: {},
    selectedSnapshotDate: null,
    totalFocusMs: 0,
    focusSessionStart: null,
    dailyStats: { date: null, started: 0, completed: 0 }
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
      activity: parsed.activity || getDefaultState().activity,
      totalFocusMs: parsed.totalFocusMs || 0,
      focusSessionStart: null,
      dailyStats: parsed.dailyStats || { date: null, started: 0, completed: 0 }
    });
    if (!state.tasks.queue) {
      state.tasks.queue = [];
    }
    ['queue', 'now', 'waiting', 'done'].forEach(function (lane) {
      if (!Array.isArray(state.tasks[lane])) {
        state.tasks[lane] = [];
      }
    });
    backfillWaitingSince();
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

function ensureDailyStats() {
  var today = todayKey();
  if (!state.dailyStats || state.dailyStats.date !== today) {
    state.dailyStats = { date: today, started: 0, completed: 0 };
  }
}

function incrementDailyStarted() {
  ensureDailyStats();
  state.dailyStats.started += 1;
}

function incrementDailyCompleted() {
  ensureDailyStats();
  state.dailyStats.completed += 1;
}

function getCarriedForwardCount() {
  return state.tasks.queue.length + state.tasks.now.length + state.tasks.waiting.length;
}

function buildExecutionScore() {
  ensureDailyStats();
  return {
    completed: state.tasks.done.length,
    waiting: state.tasks.waiting.length,
    focusTimeMinutes: getFocusTimeMinutes(),
    started: state.dailyStats.started,
    completedToday: state.dailyStats.completed,
    carriedForward: getCarriedForwardCount()
  };
}

function formatExecutionScoreLine(score) {
  if (!score) return '';
  return score.completed + ' Completed · ' +
    score.waiting + ' Waiting · ' +
    (score.focusTimeMinutes || 0) + 'm Focus';
}

function formatEodScoreLine(score) {
  if (!score) return '';
  return (score.started || 0) + ' Started · ' +
    (score.completedToday || score.completed || 0) + ' Completed · ' +
    (score.carriedForward || 0) + ' Carried Forward';
}

function endFocusSession() {
  if (state.focusSessionStart) {
    state.totalFocusMs = (state.totalFocusMs || 0) + (Date.now() - state.focusSessionStart);
    state.focusSessionStart = null;
  }
}

function getFocusTimeMinutes() {
  var total = state.totalFocusMs || 0;
  if (state.focusSessionStart) {
    total += Date.now() - state.focusSessionStart;
  }
  return Math.floor(total / 60000);
}

function formatFocusTimeDisplay() {
  var minutes = getFocusTimeMinutes();
  return minutes + 'm';
}

function updateMetrics() {
  ensureDailyStats();

  var queue = state.tasks.queue.length;
  var active = state.tasks.now.length;
  var waiting = state.tasks.waiting.length;
  var done = state.tasks.done.length;
  var carried = getCarriedForwardCount();

  var scoreCompleted = document.getElementById('score-completed');
  var scoreWaiting = document.getElementById('score-waiting');
  var scoreFocusTime = document.getElementById('score-focus-time');
  if (scoreCompleted) scoreCompleted.textContent = done;
  if (scoreWaiting) scoreWaiting.textContent = waiting;
  if (scoreFocusTime) scoreFocusTime.textContent = formatFocusTimeDisplay();

  document.getElementById('badge-queue').textContent = queue;
  document.getElementById('badge-now').textContent = active;
  document.getElementById('badge-waiting').textContent = waiting;
  document.getElementById('badge-done').textContent = done;

  document.getElementById('mission-sub-counts').textContent =
    queue + ' Queue · ' + active + ' Active · ' + waiting + ' Waiting · ' + done + ' Done';

  var eodStarted = document.getElementById('eod-started');
  var eodCompleted = document.getElementById('eod-completed');
  var eodCarried = document.getElementById('eod-carried');
  if (eodStarted) eodStarted.textContent = state.dailyStats.started;
  if (eodCompleted) eodCompleted.textContent = state.dailyStats.completed;
  if (eodCarried) eodCarried.textContent = carried;

  var started = state.dailyStats.started;
  var completedToday = state.dailyStats.completed;
  var pct = started > 0
    ? Math.min(100, Math.round((completedToday / started) * 100))
    : 0;
  var progressWrap = document.getElementById('daily-progress-wrap');
  var progressFill = document.getElementById('daily-progress-fill');
  var progressLabel = document.getElementById('daily-progress-label');
  if (progressWrap) {
    progressWrap.hidden = started === 0;
    if (started > 0) {
      if (progressFill) progressFill.style.width = pct + '%';
      if (progressLabel) progressLabel.textContent = pct + '%';
    }
  }

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

function logActivity(message, taskName, type, taskId) {
  if (type === undefined) {
    type = taskName ? 'work' : 'system';
  }

  var lastEntry = state.activity[0];

  if (taskName && type === 'work' && lastEntry && lastEntry.taskName === taskName && lastEntry.type === 'work') {
    lastEntry.message += ' → ' + message;
    lastEntry.time = formatTimestamp(new Date());
    if (taskId) {
      lastEntry.taskId = taskId;
    }
  } else {
    state.activity.unshift({
      time: formatTimestamp(new Date()),
      message: message,
      taskName: taskName || null,
      type: type,
      taskId: taskId || null
    });
  }

  if (state.activity.length > 80) {
    state.activity = state.activity.slice(0, 80);
  }
  renderActivity();
}

function scrollToTask(taskId) {
  var taskEl = document.querySelector('[data-id="' + taskId + '"]');
  if (!taskEl) return;

  taskEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  taskEl.classList.add('highlight');
  window.setTimeout(function () {
    taskEl.classList.remove('highlight');
  }, 1600);
}

function logStepIcon(step) {
  var trimmed = step.trim();
  if (trimmed.indexOf('Added') === 0) return '+';
  if (trimmed.indexOf('Started') === 0) return '▶';
  if (trimmed === 'Completed') return '✓';
  if (trimmed === 'Waiting') return '⏸';
  if (trimmed === 'Removed') return '✕';
  if (trimmed === 'Focus set' || trimmed === 'Focus') return '★';
  return null;
}

function appendLogSteps(container, message) {
  var steps = message.split(' → ');
  steps.forEach(function (step, index) {
    if (index > 0) {
      var sep = document.createElement('span');
      sep.className = 'log-separator';
      sep.textContent = '→';
      sep.setAttribute('aria-hidden', 'true');
      container.appendChild(sep);
    }

    var stepEl = document.createElement('span');
    stepEl.className = 'log-step';
    var icon = logStepIcon(step);

    if (icon) {
      var iconEl = document.createElement('span');
      iconEl.className = 'log-icon';
      iconEl.setAttribute('aria-hidden', 'true');
      iconEl.textContent = icon;
      stepEl.appendChild(iconEl);
      stepEl.setAttribute('title', step.trim());
      stepEl.setAttribute('aria-label', step.trim());
    } else {
      stepEl.textContent = step.trim();
    }

    container.appendChild(stepEl);
  });
}

function renderActivity() {
  var stream = document.getElementById('timeline-stream');
  stream.innerHTML = '';

  state.activity.forEach(function (entry) {
    var entryType = entry.type || (entry.taskName ? 'work' : 'system');
    var item = document.createElement('div');
    item.className = 'timeline-item entry type-' + entryType;

    if (entry.taskId) {
      item.classList.add('is-clickable');
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
    }

    var time = document.createElement('time');
    time.textContent = entry.time;

    var msg = document.createElement('span');
    msg.className = 'timeline-message';
    if (entry.taskName && entryType === 'work') {
      var label = document.createElement('strong');
      label.className = 'timeline-task';
      label.textContent = entry.taskName;
      msg.appendChild(label);
      msg.appendChild(document.createTextNode(' — '));
      appendLogSteps(msg, entry.message);
    } else {
      msg.textContent = entry.message;
    }

    item.appendChild(time);
    item.appendChild(msg);

    if (entry.taskId) {
      (function (id) {
        item.addEventListener('click', function () {
          scrollToTask(id);
        });
        item.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            scrollToTask(id);
          }
        });
      })(entry.taskId);
    }

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

    if (task.waitingSince) {
      var age = document.createElement('span');
      age.className = 'task-age';
      age.textContent = formatWaitingAge(task.waitingSince);
      card.appendChild(age);
    }
  }

  if (laneKey === 'done') {
    if (task.elapsedMinutes != null) {
      var elapsed = document.createElement('div');
      elapsed.className = 'task-elapsed';
      elapsed.textContent = task.elapsedMinutes < 1
        ? 'Completed in < 1 min'
        : 'Completed in ' + task.elapsedMinutes + ' min';
      card.appendChild(elapsed);
    }

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

  var tasks = state.tasks[laneKey].slice();
  if (laneKey === 'now') {
    tasks.sort(function (a, b) {
      if (a.focused && !b.focused) return -1;
      if (!a.focused && b.focused) return 1;
      return 0;
    });
  }

  tasks.forEach(function (task) {
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
  var score = snap.executionScore;

  if (score) {
    var metrics = document.createElement('div');
    metrics.className = 'snapshot-preview-metrics';
    metrics.textContent = 'Execution Score: ' + formatExecutionScoreLine(score);
    box.appendChild(metrics);

    var eodLine = document.createElement('div');
    eodLine.className = 'snapshot-preview-metrics';
    eodLine.textContent = 'EOD: ' + formatEodScoreLine(score);
    box.appendChild(eodLine);
  }

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
  endFocusSession();
  state.snapshots[key] = {
    mission: state.mission,
    targets: state.targets,
    tasks: JSON.parse(JSON.stringify(state.tasks)),
    savedAt: new Date().toISOString(),
    archivedDone: existing && existing.archivedDone ? existing.archivedDone : [],
    executionScore: buildExecutionScore()
  };
  state.selectedSnapshotDate = key;
  logActivity('Saved daily snapshot for ' + key, null, 'system');
  renderSnapshots();
  saveToLocalStorage();
}

function clearAllBoard() {
  var total = ['queue', 'now', 'waiting', 'done'].reduce(function (sum, lane) {
    return sum + state.tasks[lane].length;
  }, 0);

  if (total === 0) {
    logActivity('Clear All — board already empty', null, 'system');
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

  logActivity('Clear All — removed ' + total + ' task(s)', null, 'system');
  renderBoard();
}

function startNewDay() {
  var doneTasks = state.tasks.done;

  if (doneTasks.length === 0) {
    logActivity('New Day — Done lane already clear', null, 'system');
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

  endFocusSession();
  var executionScore = buildExecutionScore();

  if (!existing) {
    state.snapshots[key] = {
      mission: state.mission,
      targets: state.targets,
      tasks: JSON.parse(JSON.stringify(state.tasks)),
      savedAt: new Date().toISOString(),
      archivedDone: [archiveBatch],
      executionScore: executionScore
    };
  } else {
    if (!existing.archivedDone) {
      existing.archivedDone = [];
    }
    existing.archivedDone.push(archiveBatch);
    existing.tasks = JSON.parse(JSON.stringify(state.tasks));
    existing.savedAt = new Date().toISOString();
    existing.executionScore = executionScore;
  }

  state.tasks.done = [];
  state.selectedSnapshotDate = key;
  logActivity('New Day — archived ' + doneTasks.length + ' completed task(s)', null, 'system');
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
  backfillWaitingSince();

  syncMissionFieldsToDOM();
  logActivity('Loaded snapshot from ' + dateKey, null, 'system');
  renderBoard();
}

function addTask(lane, text) {
  var task = { id: uid(), text: text, focused: false };
  if (lane === 'now') {
    task.startTime = Date.now();
    incrementDailyStarted();
  }
  state.tasks[lane].push(task);
  logActivity('Added to ' + LANE_LABELS[lane], text, 'work', task.id);
  renderBoard();
}

function addWaitingTask(raw) {
  var parts = raw.split('—');
  var name = parts[0] ? parts[0].trim() : 'Context';
  var reason = parts[1] ? parts[1].trim() : 'Awaiting updates';

  var task = {
    id: uid(),
    text: name,
    context: reason,
    waitingSince: Date.now()
  };
  state.tasks.waiting.push(task);

  logActivity('Added to Waiting', name, 'work', task.id);
  renderBoard();
}

function deleteTask(lane, id) {
  var task = state.tasks[lane].find(function (t) { return t.id === id; });
  if (task && task.focused) {
    endFocusSession();
  }
  state.tasks[lane] = state.tasks[lane].filter(function (t) { return t.id !== id; });
  if (task) logActivity('Removed', task.text, 'work', task.id);
  renderBoard();
}

function setFocusTask(id) {
  endFocusSession();
  state.tasks.now.forEach(function (t) {
    t.focused = t.id === id ? !t.focused : false;
  });
  var focused = state.tasks.now.find(function (t) { return t.focused; });
  if (focused) {
    state.focusSessionStart = Date.now();
  }
  logActivity(focused ? 'Focus set' : 'Focus cleared', focused ? focused.text : null, focused ? 'work' : 'system', focused ? focused.id : null);
  renderBoard();
}

function togglePrimaryFocus() {
  if (state.tasks.now.length === 0) return;
  endFocusSession();
  var current = state.tasks.now.findIndex(function (t) { return t.focused; });
  state.tasks.now.forEach(function (t) { t.focused = false; });
  var nextIndex = current >= 0 ? (current + 1) % state.tasks.now.length : 0;
  state.tasks.now[nextIndex].focused = true;
  state.focusSessionStart = Date.now();
  logActivity('Focus', state.tasks.now[nextIndex].text, 'work', state.tasks.now[nextIndex].id);
  renderBoard();
}

function moveTask(sourceLane, targetLane, taskId) {
  if (sourceLane === targetLane) return;

  var idx = state.tasks[sourceLane].findIndex(function (t) { return t.id === taskId; });
  if (idx === -1) return;

  var task = state.tasks[sourceLane].splice(idx, 1)[0];
  if (task.focused) {
    endFocusSession();
  }
  task.focused = false;

  if (sourceLane === 'now' && targetLane !== 'done') {
    delete task.startTime;
  }

  if (sourceLane === 'waiting' && targetLane !== 'waiting') {
    delete task.waitingSince;
  }

  if (targetLane === 'done') {
    task.timestamp = formatTimestamp(new Date());
    if (task.startTime) {
      task.elapsedMinutes = Math.floor((Date.now() - task.startTime) / 60000);
    }
    incrementDailyCompleted();
    logActivity('Completed', task.text, 'work', task.id);
  } else if (targetLane === 'waiting') {
    if (!task.context) {
      task.context = 'Awaiting updates';
    }
    task.waitingSince = Date.now();
    logActivity('Waiting', task.text, 'work', task.id);
  } else if (targetLane === 'now' && state.tasks.now.length >= CURRENT_WORK_LIMIT) {
    task.startTime = Date.now();
    incrementDailyStarted();
    logActivity('Started (over capacity)', task.text, 'work', task.id);
  } else if (targetLane === 'now') {
    task.startTime = Date.now();
    incrementDailyStarted();
    logActivity('Started', task.text, 'work', task.id);
  } else {
    logActivity('Moved to ' + LANE_LABELS[targetLane], task.text, 'work', task.id);
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

function openShortcutsModal() {
  var modal = document.getElementById('shortcuts-modal');
  modal.hidden = false;
  document.getElementById('shortcuts-close').focus();
}

function closeShortcutsModal() {
  document.getElementById('shortcuts-modal').hidden = true;
}

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

  document.getElementById('toggle-sidebar').addEventListener('click', function () {
    var sidebar = document.getElementById('sidebar');
    var shell = document.querySelector('.app-shell');
    var collapsed = sidebar.classList.toggle('collapsed');
    shell.classList.toggle('sidebar-collapsed', collapsed);
  });

  document.getElementById('shortcuts-btn').addEventListener('click', openShortcutsModal);
  document.getElementById('shortcuts-close').addEventListener('click', closeShortcutsModal);
  document.getElementById('shortcuts-backdrop').addEventListener('click', closeShortcutsModal);
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', function (e) {
    var modal = document.getElementById('shortcuts-modal');
    if (!modal.hidden && e.key === 'Escape') {
      e.preventDefault();
      closeShortcutsModal();
      return;
    }

    if (isTypingTarget(e.target)) return;

    switch (e.key.toLowerCase()) {
      case '?':
        e.preventDefault();
        openShortcutsModal();
        break;
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
  backfillWaitingSince();
  syncMissionFieldsToDOM();
  setupEventListeners();
  setupKeyboardShortcuts();
  renderActivity();
  renderBoard();

  var focusedTask = state.tasks.now.find(function (t) { return t.focused; });
  if (focusedTask) {
    state.focusSessionStart = Date.now();
  }

  window.setInterval(function () {
    var scoreFocusTime = document.getElementById('score-focus-time');
    if (scoreFocusTime && state.focusSessionStart) {
      scoreFocusTime.textContent = formatFocusTimeDisplay();
    }
  }, 30000);
});
