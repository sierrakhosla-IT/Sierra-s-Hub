'use strict';

var STORAGE_KEY = 'exec_os_v2_data';
var CURRENT_WORK_LIMIT = 5;
var SAVE_INDICATOR_MS = 2200;

var LANE_LABELS = {
  queue: 'Queue',
  now: 'Current Work',
  waiting: 'Waiting',
  done: 'Done'
};

var TICKET_STATUS_ROWS = [
  { key: 'active', label: 'Active' },
  { key: 'mobilityRequests', label: 'Mobility Requests' },
  { key: 'pendingUser', label: 'Pending User' },
  { key: 'pendingIT', label: 'Pending IT' },
  { key: 'onHold', label: 'On Hold' }
];

function defaultTicketStatus() {
  return {
    active: 14,
    mobilityRequests: 6,
    pendingUser: 4,
    pendingIT: 3,
    onHold: 2
  };
}

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
  dailyStats: { date: null, started: 0, completed: 0 },
  ticketStatus: defaultTicketStatus(),
  settings: {
    autoArchiveDone: true,
    archiveAfterDays: 7
  },
  history: []
};

var draggedTaskId = null;
var draggedSourceLane = null;
var saveIndicatorTimer = null;

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

function parseTaskInput(raw) {
  var text = (raw || '').trim();
  var priority = null;
  var tags = [];
  var priorityMatch = text.match(/!(high|medium|low|urgent)\b/i);

  if (priorityMatch) {
    priority = priorityMatch[1].toLowerCase();
    text = text.replace(/!(high|medium|low|urgent)\b/i, '').trim();
  }

  var tagRegex = /@([\w-]+)/g;
  var tagMatch;
  while ((tagMatch = tagRegex.exec(text)) !== null) {
    tags.push(tagMatch[1].toLowerCase());
  }
  text = text.replace(/@[\w-]+/g, '').replace(/\s{2,}/g, ' ').trim();

  return { text: text, priority: priority, tags: tags };
}

function applyParsedTaskFields(task, parsed) {
  if (parsed.priority) {
    task.priority = parsed.priority;
  }
  if (parsed.tags.length) {
    task.tags = parsed.tags.slice();
  }
}

function showSaveIndicator() {
  var el = document.getElementById('save-status');
  if (!el) return;
  el.classList.add('is-saved');
  clearTimeout(saveIndicatorTimer);
  saveIndicatorTimer = setTimeout(function () {
    el.classList.remove('is-saved');
  }, SAVE_INDICATOR_MS);
}

function ensureSettings() {
  if (!state.settings) {
    state.settings = { autoArchiveDone: true, archiveAfterDays: 7 };
  }
  if (state.settings.autoArchiveDone == null) {
    state.settings.autoArchiveDone = true;
  }
  if (!state.settings.archiveAfterDays) {
    state.settings.archiveAfterDays = 7;
  }
  if (!Array.isArray(state.history)) {
    state.history = [];
  }
}

function backfillCompletedAt() {
  state.tasks.done.forEach(function (task) {
    if (!task.completedAt) {
      task.completedAt = Date.now();
    }
  });
}

function archiveDoneTasks(tasks, reason) {
  if (!tasks.length) return;
  ensureSettings();
  state.history.push({
    archivedAt: new Date().toISOString(),
    reason: reason || 'manual',
    tasks: JSON.parse(JSON.stringify(tasks))
  });
}

function purgeStaleDoneTasks() {
  ensureSettings();
  if (state.settings.autoArchiveDone === false) return 0;

  var days = state.settings.archiveAfterDays || 7;
  var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  var toArchive = [];
  var keep = [];

  state.tasks.done.forEach(function (task) {
    var completedAt = task.completedAt || Date.now();
    if (completedAt < cutoff) {
      toArchive.push(task);
    } else {
      keep.push(task);
    }
  });

  if (!toArchive.length) return 0;

  archiveDoneTasks(toArchive, 'auto-archive');
  state.tasks.done = keep;
  logActivity('Auto-archived ' + toArchive.length + ' completed task(s)', null, 'system');
  return toArchive.length;
}

function getHistoryTaskCount() {
  ensureSettings();
  return state.history.reduce(function (sum, batch) {
    return sum + (batch.tasks ? batch.tasks.length : 0);
  }, 0);
}

function updateHistoryMeta() {
  var meta = document.getElementById('history-meta');
  if (!meta) return;
  meta.textContent = 'History: ' + getHistoryTaskCount() + ' archived task(s)';
}

function syncSettingsToDOM() {
  ensureSettings();
  var toggle = document.getElementById('auto-archive-toggle');
  if (toggle) {
    toggle.checked = state.settings.autoArchiveDone !== false;
  }
  updateHistoryMeta();
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
    dailyStats: { date: null, started: 0, completed: 0 },
    ticketStatus: defaultTicketStatus(),
    settings: {
      autoArchiveDone: true,
      archiveAfterDays: 7
    },
    history: []
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
      dailyStats: parsed.dailyStats || { date: null, started: 0, completed: 0 },
      ticketStatus: Object.assign(defaultTicketStatus(), parsed.ticketStatus || {}),
      settings: Object.assign(
        { autoArchiveDone: true, archiveAfterDays: 7 },
        parsed.settings || {}
      ),
      history: Array.isArray(parsed.history) ? parsed.history : []
    });
    if (!state.tasks.queue) {
      state.tasks.queue = [];
    }
    ['queue', 'now', 'waiting', 'done'].forEach(function (lane) {
      if (!Array.isArray(state.tasks[lane])) {
        state.tasks[lane] = [];
      }
    });
    ensureSettings();
    backfillWaitingSince();
    backfillCompletedAt();
  } catch (err) {
    console.warn('Execution OS: could not load saved state', err);
  }
}

function saveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    showSaveIndicator();
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
  var queue = state.tasks.queue.length;
  var active = state.tasks.now.length;
  var waiting = state.tasks.waiting.length;
  var done = state.tasks.done.length;
  var focusMinutes = getFocusTimeMinutes();
  return {
    completed: state.tasks.done.length,
    waiting: waiting,
    focusTimeMinutes: focusMinutes,
    focusTimeHours: focusMinutes >= 60 ? (focusMinutes / 60).toFixed(1) : null,
    started: state.dailyStats.started,
    completedToday: state.dailyStats.completed,
    carriedForward: getCarriedForwardCount(),
    planned: queue + active + waiting + done,
    inProgress: active,
    productivityScore: computeProductivityScore()
  };
}

function computeProductivityScore() {
  ensureDailyStats();
  var started = Math.max(state.dailyStats.started, 1);
  var completedToday = state.dailyStats.completed;
  var focusMinutes = getFocusTimeMinutes();
  var completionRatio = Math.min(1, completedToday / started);
  var focusRatio = Math.min(1, focusMinutes / 240);
  return Math.round((completionRatio * 0.6 + focusRatio * 0.4) * 100);
}

function formatFocusTimeForMetric() {
  var minutes = getFocusTimeMinutes();
  if (minutes >= 60) {
    return (minutes / 60).toFixed(1) + 'h';
  }
  return minutes + 'm';
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

  var scoreCompleted = document.getElementById('score-completed');
  var scoreWaiting = document.getElementById('score-waiting');
  var scoreFocusTime = document.getElementById('score-focus-time');
  if (scoreCompleted) scoreCompleted.textContent = state.dailyStats.completed;
  if (scoreWaiting) scoreWaiting.textContent = waiting;
  if (scoreFocusTime) scoreFocusTime.textContent = formatFocusTimeDisplay();

  var metricPlanned = document.getElementById('metric-planned');
  var metricCompleted = document.getElementById('metric-completed');
  var metricInProgress = document.getElementById('metric-in-progress');
  var metricWaiting = document.getElementById('metric-waiting');
  var metricFocusTime = document.getElementById('metric-focus-time');
  var plannedTotal = queue + active + waiting + done;
  if (metricPlanned) metricPlanned.textContent = plannedTotal;
  if (metricCompleted) metricCompleted.textContent = state.dailyStats.completed;
  if (metricInProgress) metricInProgress.textContent = active;
  if (metricWaiting) metricWaiting.textContent = waiting;
  if (metricFocusTime) metricFocusTime.textContent = formatFocusTimeForMetric();

  var productivityEl = document.getElementById('productivity-score');
  if (productivityEl) {
    var score = computeProductivityScore();
    productivityEl.textContent = 'Score ' + score;
    productivityEl.hidden = plannedTotal === 0 && state.dailyStats.completed === 0 && getFocusTimeMinutes() === 0;
  }

  document.getElementById('badge-queue').textContent = queue;
  document.getElementById('badge-now').textContent = active;
  document.getElementById('badge-waiting').textContent = waiting;
  document.getElementById('badge-done').textContent = done;

  document.getElementById('mission-sub-counts').textContent =
    queue + ' Queue · ' + active + ' Active · ' + waiting + ' Waiting · ' + done + ' Done';

  var started = state.dailyStats.started;
  var completedToday = state.dailyStats.completed;
  var pct = started > 0
    ? Math.min(100, Math.round((completedToday / started) * 100))
    : 0;
  var progressFill = document.getElementById('daily-progress-fill');
  var progressLabel = document.getElementById('daily-progress-label');
  if (progressFill) progressFill.style.width = pct + '%';
  if (progressLabel) progressLabel.textContent = pct + '%';

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

function formatLogLine(taskName, message) {
  var last = message.split(' → ').pop().trim();

  if (last === 'Completed') {
    return { icon: '✓', text: 'Finished ' + taskName };
  }
  if (last === 'Waiting') {
    return { icon: '⏸', text: 'Waiting on ' + taskName };
  }
  if (last.indexOf('Started') === 0) {
    return { icon: '▶', text: 'Started ' + taskName };
  }
  if (last.indexOf('Added to') === 0) {
    return { icon: '+', text: taskName };
  }
  if (last.indexOf('Moved to') === 0) {
    return { icon: '→', text: taskName + ' — ' + last.replace('Moved to ', 'moved to ') };
  }
  if (last === 'Removed') {
    return { icon: '✕', text: 'Removed ' + taskName };
  }
  if (last === 'Focus set' || last === 'Focus') {
    return { icon: '★', text: 'Focus on ' + taskName };
  }

  return { icon: logStepIcon(last), text: taskName + ' — ' + last };
}

function formatSnapshotDayLabel(dateKey) {
  if (dateKey === todayKey()) return 'Today';
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === yesterday.toISOString().slice(0, 10)) return 'Yesterday';

  return new Date(dateKey + 'T12:00:00').toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  });
}

function buildSnapshotSummary(snap) {
  var score = snap.executionScore || {};
  var completed = score.completedToday != null ? score.completedToday : (snap.tasks.done ? snap.tasks.done.length : 0);
  var carried = (snap.tasks.queue ? snap.tasks.queue.length : 0) + snap.tasks.waiting.length;
  var focusArea = snap.mission || 'No mission recorded';
  var blocker = 'None recorded';

  if (snap.tasks.waiting && snap.tasks.waiting.length) {
    var oldest = snap.tasks.waiting.slice().sort(function (a, b) {
      return (a.waitingSince || 0) - (b.waitingSince || 0);
    })[0];
    blocker = oldest.context
      ? oldest.text + ' — ' + oldest.context
      : oldest.text;
  } else if (snap.ticketStatus && snap.ticketStatus.pendingUser > 0) {
    blocker = 'Pending User (' + snap.ticketStatus.pendingUser + ')';
  } else if (snap.ticketStatus && snap.ticketStatus.onHold > 0) {
    blocker = 'On Hold (' + snap.ticketStatus.onHold + ')';
  }

  if (snap.ticketStatus && snap.ticketStatus.mobilityRequests > 0) {
    focusArea = 'Mobility Requests (' + snap.ticketStatus.mobilityRequests + ')';
  }

  var metricsSummary = '';
  if (score.planned != null) {
    var focusLabel = score.focusTimeHours
      ? score.focusTimeHours + 'h focus'
      : (score.focusTimeMinutes || 0) + 'm focus';
    metricsSummary = score.planned + ' planned · ' +
      (score.completedToday != null ? score.completedToday : completed) + ' completed · ' +
      focusLabel;
  }

  return {
    completed: completed,
    carried: carried,
    focusArea: focusArea,
    blocker: blocker,
    metricsSummary: metricsSummary
  };
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
      var line = formatLogLine(entry.taskName, entry.message);
      var lineWrap = document.createElement('span');
      lineWrap.className = 'timeline-log-line';

      if (line.icon) {
        var iconEl = document.createElement('span');
        iconEl.className = 'timeline-log-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = line.icon;
        lineWrap.appendChild(iconEl);
      }

      var textEl = document.createElement('span');
      textEl.className = 'timeline-log-text';
      textEl.textContent = line.text;
      lineWrap.appendChild(textEl);
      msg.appendChild(lineWrap);
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

function appendTaskMetaBadges(card, task) {
  if (!task.priority && (!task.tags || !task.tags.length)) return;

  var wrap = document.createElement('div');
  wrap.className = 'task-meta-badges';

  if (task.priority) {
    var priority = document.createElement('span');
    priority.className = 'task-priority-badge priority-' + task.priority;
    priority.textContent = task.priority;
    wrap.appendChild(priority);
  }

  if (task.tags && task.tags.length) {
    task.tags.forEach(function (tag) {
      var badge = document.createElement('span');
      badge.className = 'task-tag-badge';
      badge.textContent = '@' + tag;
      wrap.appendChild(badge);
    });
  }

  card.appendChild(wrap);
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

  if (laneKey === 'waiting') {
    card.classList.add('waiting-task-card');

    var title = document.createElement('div');
    title.className = 'waiting-task-title task-text';
    title.contentEditable = 'true';
    title.spellcheck = true;
    title.textContent = task.text;
    title.addEventListener('focus', function () {
      card.draggable = false;
    });
    title.addEventListener('blur', function () {
      card.draggable = true;
      updateTaskText(laneKey, task.id, title.innerText.trim());
    });
    title.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        title.blur();
      }
    });
    main.appendChild(title);

    var parsed = parseWaitingContext(task.context || '');
    var meta = document.createElement('div');
    meta.className = 'waiting-task-meta';

    var partyRow = document.createElement('div');
    partyRow.className = 'waiting-task-row';
    var partyLabel = document.createElement('span');
    partyLabel.className = 'waiting-meta-label';
    partyLabel.textContent = 'Waiting on';
    var party = document.createElement('span');
    party.className = 'waiting-task-party task-context';
    party.contentEditable = 'true';
    party.spellcheck = true;
    party.textContent = parsed.party;
    partyRow.appendChild(partyLabel);
    partyRow.appendChild(party);
    meta.appendChild(partyRow);

    var noteRow = document.createElement('div');
    noteRow.className = 'waiting-task-row waiting-task-row--note';
    if (!parsed.note) noteRow.hidden = true;
    var noteLabel = document.createElement('span');
    noteLabel.className = 'waiting-meta-label';
    noteLabel.textContent = 'Note';
    var note = document.createElement('span');
    note.className = 'waiting-task-note task-context';
    note.contentEditable = 'true';
    note.spellcheck = true;
    note.textContent = parsed.note;
    noteRow.appendChild(noteLabel);
    noteRow.appendChild(note);
    meta.appendChild(noteRow);

    bindWaitingContextEditors(card, laneKey, task, party, note);
    party.addEventListener('blur', function () {
      noteRow.hidden = !note.textContent.trim();
    });
    note.addEventListener('input', function () {
      noteRow.hidden = false;
    });

    main.appendChild(meta);

    var footer = document.createElement('div');
    footer.className = 'waiting-task-footer';

    var age = document.createElement('span');
    age.className = 'task-age';
    age.textContent = formatWaitingAge(task.waitingSince);
    footer.appendChild(age);

    if (task.expectedBy) {
      var expected = document.createElement('span');
      expected.className = 'task-expected-by';
      expected.textContent = 'Due ' + formatExpectedBy(task.expectedBy);
      footer.appendChild(expected);
    }

    main.appendChild(footer);
  } else {
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
  }

  card.appendChild(deleteBtn);
  card.appendChild(main);
  appendTaskMetaBadges(card, task);

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
  updateHistoryMeta();
  saveToLocalStorage();
}

function syncMissionFieldsToDOM() {
  document.getElementById('directive-display').textContent = state.mission;

  var list = document.getElementById('mission-targets-list');
  list.innerHTML = '';
  state.targets.split('\n').filter(Boolean).forEach(function (line) {
    var li = document.createElement('li');
    li.textContent = line.replace(/^[\s•\-]+/, '');
    list.appendChild(li);
  });
}

function syncMissionFieldsFromDOM() {
  state.mission = document.getElementById('directive-display').innerText.trim();
  var items = Array.prototype.map.call(
    document.querySelectorAll('#mission-targets-list li'),
    function (li) { return li.innerText.trim(); }
  ).filter(Boolean);
  state.targets = items.join('\n');
}

function parseMetricValue(raw, fallback) {
  var parsed = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
  if (isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

function formatTicketStatusLine(status) {
  if (!status) return '';
  return TICKET_STATUS_ROWS.map(function (row) {
    return row.label + ' ' + (status[row.key] != null ? status[row.key] : 0);
  }).join(' · ');
}

function syncTicketStatusToDOM() {
  if (!state.ticketStatus) {
    state.ticketStatus = defaultTicketStatus();
  }

  TICKET_STATUS_ROWS.forEach(function (row) {
    var el = document.querySelector('[data-metric="' + row.key + '"]');
    if (el) {
      el.textContent = state.ticketStatus[row.key];
    }
  });
}

function syncTicketStatusFromDOM() {
  if (!state.ticketStatus) {
    state.ticketStatus = defaultTicketStatus();
  }

  var prev = JSON.stringify(state.ticketStatus);

  TICKET_STATUS_ROWS.forEach(function (row) {
    var el = document.querySelector('[data-metric="' + row.key + '"]');
    if (el) {
      state.ticketStatus[row.key] = parseMetricValue(
        el.innerText,
        state.ticketStatus[row.key]
      );
    }
  });

  syncTicketStatusToDOM();

  if (JSON.stringify(state.ticketStatus) !== prev) {
    logActivity('Ticket status updated — ' + formatTicketStatusLine(state.ticketStatus), null, 'system');
  }
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
      ? 'Select a day to view summary'
      : 'Save Today to capture your first daily summary';
    box.appendChild(ph);
    return;
  }

  var snap = state.snapshots[state.selectedSnapshotDate];
  var summary = buildSnapshotSummary(snap);
  var wrap = document.createElement('div');
  wrap.className = 'snapshot-summary';

  var title = document.createElement('div');
  title.className = 'snapshot-summary-title';
  title.textContent = formatSnapshotDayLabel(state.selectedSnapshotDate);
  wrap.appendChild(title);

  var lines = [];
  if (summary.metricsSummary) {
    lines.push(summary.metricsSummary);
  }
  lines.push(
    '✓ ' + summary.completed + ' completed',
    '✓ ' + summary.carried + ' carried over',
    'Most time spent: ' + summary.focusArea,
    'Biggest blocker: ' + summary.blocker
  );

  lines.forEach(function (text, index) {
    var line = document.createElement('div');
    line.className = 'snapshot-summary-line' + (index >= (summary.metricsSummary ? 3 : 2) ? ' is-highlight' : '');
    line.textContent = text;
    wrap.appendChild(line);
  });

  box.appendChild(wrap);
}

function saveSnapshot() {
  var key = todayKey();
  var existing = state.snapshots[key];
  endFocusSession();
  state.snapshots[key] = {
    mission: state.mission,
    targets: state.targets,
    ticketStatus: JSON.parse(JSON.stringify(state.ticketStatus)),
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
      ticketStatus: JSON.parse(JSON.stringify(state.ticketStatus)),
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
    existing.ticketStatus = JSON.parse(JSON.stringify(state.ticketStatus));
    existing.savedAt = new Date().toISOString();
    existing.executionScore = executionScore;
  }

  state.tasks.done = [];
  state.selectedSnapshotDate = key;
  logActivity('New Day — archived ' + doneTasks.length + ' completed task(s)', null, 'system');
  renderBoard();
}

function resetDay() {
  var nowTasks = state.tasks.now.slice();
  var doneTasks = state.tasks.done.slice();

  if (nowTasks.length === 0 && doneTasks.length === 0) {
    logActivity('Reset Day — nothing to reset', null, 'system');
    return;
  }

  if (!confirm(
    'Reset today? ' + nowTasks.length + ' Current Work task(s) return to Queue and ' +
    doneTasks.length + ' Done task(s) will be archived to History.'
  )) {
    return;
  }

  endFocusSession();

  if (doneTasks.length) {
    archiveDoneTasks(doneTasks, 'reset-day');
  }

  nowTasks.forEach(function (task) {
    task.focused = false;
    delete task.startTime;
    state.tasks.queue.push(task);
  });

  state.tasks.now = [];
  state.tasks.done = [];
  state.totalFocusMs = 0;
  state.dailyStats = { date: todayKey(), started: 0, completed: 0 };

  logActivity(
    'Reset Day — ' + nowTasks.length + ' returned to Queue, ' + doneTasks.length + ' archived',
    null,
    'system'
  );
  renderBoard();
}

function exportStateToJson() {
  var payload = JSON.stringify(state, null, 2);
  var blob = new Blob([payload], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'execution-os-backup-' + todayKey() + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  logActivity('Exported JSON backup', null, 'system');
  renderActivity();
  saveToLocalStorage();
}

function importStateFromFile(file) {
  if (!file) return;

  var reader = new FileReader();
  reader.onload = function (event) {
    try {
      var parsed = JSON.parse(event.target.result);
      if (!parsed || typeof parsed !== 'object' || !parsed.tasks) {
        alert('Invalid backup file — expected Execution OS JSON export.');
        return;
      }

      if (!confirm('Replace all current board data with this backup? This cannot be undone.')) {
        return;
      }

      endFocusSession();
      state = Object.assign(getDefaultState(), parsed, {
        tasks: Object.assign(getDefaultState().tasks, parsed.tasks || {}),
        snapshots: parsed.snapshots || {},
        activity: parsed.activity || getDefaultState().activity,
        totalFocusMs: parsed.totalFocusMs || 0,
        focusSessionStart: null,
        dailyStats: parsed.dailyStats || { date: null, started: 0, completed: 0 },
        ticketStatus: Object.assign(defaultTicketStatus(), parsed.ticketStatus || {}),
        settings: Object.assign(
          { autoArchiveDone: true, archiveAfterDays: 7 },
          parsed.settings || {}
        ),
        history: Array.isArray(parsed.history) ? parsed.history : []
      });

      ['queue', 'now', 'waiting', 'done'].forEach(function (lane) {
        if (!Array.isArray(state.tasks[lane])) {
          state.tasks[lane] = [];
        }
      });

      ensureSettings();
      backfillWaitingSince();
      backfillCompletedAt();
      syncMissionFieldsToDOM();
      syncTicketStatusToDOM();
      syncSettingsToDOM();
      logActivity('Imported JSON backup', null, 'system');
      renderBoard();
    } catch (err) {
      alert('Could not import backup: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function openQuickCaptureModal() {
  var modal = document.getElementById('quick-capture-modal');
  var input = document.getElementById('quick-capture-input');
  modal.hidden = false;
  input.value = '';
  input.focus();
}

function closeQuickCaptureModal() {
  var modal = document.getElementById('quick-capture-modal');
  modal.hidden = true;
}

function submitQuickCapture() {
  var input = document.getElementById('quick-capture-input');
  var value = input.value.trim();
  if (!value) return;
  addTask('queue', value);
  input.value = '';
  closeQuickCaptureModal();
}

function openSettingsModal() {
  syncSettingsToDOM();
  document.getElementById('settings-modal').hidden = false;
  document.getElementById('settings-close').focus();
}

function closeSettingsModal() {
  document.getElementById('settings-modal').hidden = true;
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
  if (snap.ticketStatus) {
    state.ticketStatus = JSON.parse(JSON.stringify(snap.ticketStatus));
  }
  state.tasks = JSON.parse(JSON.stringify(snap.tasks));
  if (!state.tasks.queue) {
    state.tasks.queue = [];
  }
  state.selectedSnapshotDate = dateKey;
  backfillWaitingSince();

  syncMissionFieldsToDOM();
  syncTicketStatusToDOM();
  logActivity('Loaded snapshot from ' + dateKey, null, 'system');
  renderBoard();
}

function addTask(lane, rawInput) {
  var parsed = parseTaskInput(rawInput);
  if (!parsed.text) return null;

  var task = { id: uid(), text: parsed.text, focused: false };
  applyParsedTaskFields(task, parsed);

  if (lane === 'now') {
    task.startTime = Date.now();
    incrementDailyStarted();
  }
  state.tasks[lane].push(task);
  logActivity('Added to ' + LANE_LABELS[lane], parsed.text, 'work', task.id);
  renderBoard();
  return task;
}

function formatExpectedBy(dateStr) {
  if (!dateStr) return '';
  var parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  var date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseWaitingContext(context) {
  if (!context) return { party: '', note: '' };
  var match = context.match(/^([\s\S]*?)\s*(?:—|–)\s*([\s\S]+)$/);
  if (!match) return { party: context.trim(), note: '' };
  return { party: match[1].trim(), note: match[2].trim() };
}

function composeWaitingContext(party, note) {
  var p = (party || '').trim();
  var n = (note || '').trim();
  if (!p) return n || 'Awaiting updates';
  if (!n) return p;
  return p + ' — ' + n;
}

function bindWaitingContextEditors(card, laneKey, task, partyEl, noteEl) {
  function syncContext() {
    updateTaskContext(laneKey, task.id, composeWaitingContext(partyEl.innerText, noteEl.innerText));
  }

  [partyEl, noteEl].forEach(function (el) {
    el.addEventListener('focus', function () {
      card.draggable = false;
    });
    el.addEventListener('blur', function () {
      card.draggable = true;
      syncContext();
    });
  });
}

function addWaitingTask(raw) {
  var parts = raw.split(/\s*(?:—|–)\s*/);
  if (parts.length === 1) {
    parts = raw.split(/\s+-\s+/);
  }
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

function addWaitingTaskFromForm() {
  var taskField = document.getElementById('input-waiting-task');
  var waitingOnField = document.getElementById('input-waiting-on');
  var contextField = document.getElementById('input-waiting-context');
  var expectedField = document.getElementById('input-waiting-expected');

  var taskText = taskField && taskField.value.trim();
  var waitingOn = waitingOnField && waitingOnField.value.trim();
  var contextExtra = contextField && contextField.value.trim();
  var expectedBy = expectedField && expectedField.value;

  if (!taskText && !waitingOn) return;

  var name = taskText || 'Untitled';
  var context = waitingOn || 'Awaiting updates';
  if (contextExtra) {
    context = context + ' — ' + contextExtra;
  }

  var task = {
    id: uid(),
    text: name,
    context: context,
    waitingSince: Date.now()
  };
  if (expectedBy) {
    task.expectedBy = expectedBy;
  }
  state.tasks.waiting.push(task);

  logActivity('Added to Waiting — ' + name, null, 'work', task.id);
  if (taskField) taskField.value = '';
  if (waitingOnField) waitingOnField.value = '';
  if (contextField) contextField.value = '';
  if (expectedField) expectedField.value = '';
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
    task.completedAt = Date.now();
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

  document.getElementById('quick-capture-input').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuickCaptureModal();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitQuickCapture();
  });

  document.getElementById('quick-capture-backdrop').addEventListener('click', closeQuickCaptureModal);

  document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
  document.getElementById('settings-close').addEventListener('click', closeSettingsModal);
  document.getElementById('settings-backdrop').addEventListener('click', closeSettingsModal);
  document.getElementById('export-json-btn').addEventListener('click', exportStateToJson);
  document.getElementById('import-json-input').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (file) {
      importStateFromFile(file);
    }
    e.target.value = '';
  });
  document.getElementById('auto-archive-toggle').addEventListener('change', function (e) {
    ensureSettings();
    state.settings.autoArchiveDone = e.target.checked;
    saveToLocalStorage();
    if (e.target.checked) {
      purgeStaleDoneTasks();
      renderBoard();
      renderActivity();
    }
    updateHistoryMeta();
  });

  document.getElementById('reset-day-btn').addEventListener('click', resetDay);

  document.getElementById('waiting-form').addEventListener('submit', function (e) {
    e.preventDefault();
    addWaitingTaskFromForm();
  });

  document.getElementById('directive-display').addEventListener('blur', function () {
    syncMissionFieldsFromDOM();
    saveToLocalStorage();
  });

  document.getElementById('mission-targets-list').addEventListener('blur', function () {
    syncMissionFieldsFromDOM();
    saveToLocalStorage();
  });

  document.querySelectorAll('.queue-metric-value').forEach(function (el) {
    el.addEventListener('blur', function () {
      syncTicketStatusFromDOM();
      saveToLocalStorage();
    });
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
    var shortcutsModal = document.getElementById('shortcuts-modal');
    var quickCaptureModal = document.getElementById('quick-capture-modal');
    var settingsModal = document.getElementById('settings-modal');

    if (!shortcutsModal.hidden && e.key === 'Escape') {
      e.preventDefault();
      closeShortcutsModal();
      return;
    }

    if (!quickCaptureModal.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeQuickCaptureModal();
      }
      return;
    }

    if (!settingsModal.hidden && e.key === 'Escape') {
      e.preventDefault();
      closeSettingsModal();
      return;
    }

    if (e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      openQuickCaptureModal();
      return;
    }

    if (e.key === ',' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      openSettingsModal();
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
        document.getElementById('directive-display').focus();
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
  backfillCompletedAt();
  purgeStaleDoneTasks();
  syncMissionFieldsToDOM();
  syncTicketStatusToDOM();
  syncSettingsToDOM();
  setupEventListeners();
  setupKeyboardShortcuts();
  renderActivity();
  renderBoard();

  var focusedTask = state.tasks.now.find(function (t) { return t.focused; });
  if (focusedTask) {
    state.focusSessionStart = Date.now();
  }

  window.setInterval(function () {
    if (state.focusSessionStart) {
      var scoreFocusTime = document.getElementById('score-focus-time');
      var metricFocusTime = document.getElementById('metric-focus-time');
      var display = formatFocusTimeDisplay();
      if (scoreFocusTime) scoreFocusTime.textContent = display;
      if (metricFocusTime) metricFocusTime.textContent = formatFocusTimeForMetric();
    }
  }, 30000);
});
