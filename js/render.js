// All DOM painting for Momentum. No event listeners live here — app.js owns
// wiring. This module only reads state and streaks.js and writes to the DOM
// ids/attributes defined in index.html.

import { todayISO, addDays, weekStart } from './dates.js';
import {
  dailyStreak,
  weeklyQuotaStreak,
  weeklyQuotaProgress,
  cumulativeStats,
  historyWeeks,
  habitCounts,
  intensityLevel,
} from './streaks.js';
import { activeHabitsOn, activeCoresOn, effectiveThreshold } from './habits.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthDay(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Labels rotated so index 0 is the configured first day of the week.
function weekdayLabels(weekStartsOn) {
  const shift = { monday: 0, sunday: 6, saturday: 5 }[weekStartsOn] ?? 0;
  if (shift === 0) return WEEKDAY_LABELS;
  return [...WEEKDAY_LABELS.slice(shift), ...WEEKDAY_LABELS.slice(0, shift)];
}

function formatTime12h(hhmm) {
  const parts = String(hhmm || '22:00').split(':');
  let h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${period}`;
}

function setPressed(el, pressed) {
  if (el) el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

export function renderSyncStatus(status, message) {
  const el = document.getElementById('sync-status');
  if (!el) return;

  const classByStatus = {
    off: '',
    syncing: 'pending',
    synced: 'ok',
    offline: 'pending',
    error: 'error',
  };
  const textByStatus = {
    off: '',
    syncing: 'Syncing…',
    synced: 'Synced',
    offline: 'Offline — saved locally',
    error: 'Sync error',
  };

  el.classList.remove('ok', 'pending', 'error');
  const cls = classByStatus[status] || '';
  if (cls) el.classList.add(cls);
  el.textContent = message || textByStatus[status] || '';
}

function activeWeeklyHabits(habits, dateIso) {
  return activeHabitsOn(habits, dateIso).filter((h) => h.cadence === 'weekly-quota');
}

// `trained` keeps its original copy verbatim; other weekly habits get the
// same phrasing built from their label.
function weeklyCaption(habit) {
  return habit.id === 'trained' ? 'week training streak' : `week ${habit.label.toLowerCase()} streak`;
}

function weeklyDotsLabel(habit) {
  return habit.id === 'trained' ? 'Training days this week' : `${habit.label} days this week`;
}

function buildWeeklyBlock(state, habit, todayIso) {
  const weekStartsOn = state.settings.weekStartsOn;
  const block = document.createElement('div');
  block.className = 'training-block';

  const streakEl = document.createElement('div');
  streakEl.className = 'training-streak';
  streakEl.textContent = String(weeklyQuotaStreak(state.entries, habit, todayIso, weekStartsOn));
  block.appendChild(streakEl);

  const caption = document.createElement('div');
  caption.className = 'streak-caption';
  caption.textContent = weeklyCaption(habit);
  block.appendChild(caption);

  const progress = weeklyQuotaProgress(state.entries, habit, todayIso, weekStartsOn);
  const dotsEl = document.createElement('div');
  dotsEl.className = 'week-dots';
  dotsEl.setAttribute('aria-label', weeklyDotsLabel(habit));
  const labels = weekdayLabels(weekStartsOn);
  const start = weekStart(todayIso, weekStartsOn);
  for (let i = 0; i < 7; i++) {
    const dayIso = addDays(start, i);
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (progress.days[i]) dot.classList.add('hit');
    if (dayIso === todayIso) dot.classList.add('today');
    dot.title = `${labels[i]}${progress.days[i] ? ` — ${habit.label.toLowerCase()}` : ''}`;
    dotsEl.appendChild(dot);
  }
  block.appendChild(dotsEl);

  const countEl = document.createElement('div');
  countEl.className = 'week-count';
  const target = habit.weeklyTarget;
  const remaining = target - progress.count;
  // "To-go" framing once past halfway pulls harder late in the week.
  countEl.textContent =
    remaining > 0 && progress.count >= Math.ceil(target / 2)
      ? `${remaining} to go`
      : `${progress.count}/${target} this week`;
  block.appendChild(countEl);

  return block;
}

function renderStreakBlock(state, todayIso) {
  const streakEl = document.getElementById('streak-number');
  const header = document.querySelector('.today-header');
  if (!streakEl || !header) return;

  const { habits, coreSlack } = state.settings;
  const streak = dailyStreak(state.entries, habits, coreSlack, todayIso);
  const stats = cumulativeStats(state.entries, habits, coreSlack, todayIso);

  // Zero active cores today: the daily streak card is hidden entirely [R1].
  const dailyCard = streakEl.parentElement;
  if (dailyCard) dailyCard.hidden = effectiveThreshold(habits, coreSlack, todayIso) === null;

  const captionEl = dailyCard?.querySelector('.streak-caption');
  streakEl.textContent = String(streak);
  if (captionEl) {
    // Achievement framing on a broken chain: pair day 1 with the stats that
    // never reset, so history reads as banked progress rather than loss.
    captionEl.textContent =
      streak === 0 && stats.totalLogged > 0
        ? `day 1 — ${stats.totalLogged} days logged, best ${stats.bestStreak}`
        : 'day core streak';
  }

  // One block per weekly-quota habit active today, in config order.
  const syncEl = document.getElementById('sync-status');
  for (const el of header.querySelectorAll('.training-block')) el.remove();
  for (const habit of activeWeeklyHabits(habits, todayIso)) {
    header.insertBefore(buildWeeklyBlock(state, habit, todayIso), syncEl);
  }
}

// The sleep habit's row displays the concrete target time rather than its
// bare label — same behavior the old hardcoded row had.
function rowLabel(habit, settings) {
  if (habit.id === 'sleptOnTime') {
    return `Asleep by ${formatTime12h(settings.sleepTargetTime)} (last night)`;
  }
  return habit.label;
}

function buildGroupLabel(text) {
  const div = document.createElement('div');
  div.className = 'habit-group-label';
  div.textContent = text;
  return div;
}

function buildHabitRow(habit, settings) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = habit.cadence === 'bonus' ? 'habit-row bonus-row' : 'habit-row';
  btn.dataset.habit = habit.id;
  btn.setAttribute('aria-pressed', 'false');
  const span = document.createElement('span');
  span.className = 'habit-label';
  span.textContent = rowLabel(habit, settings);
  btn.appendChild(span);
  return btn;
}

// Rebuild the row DOM only when the config-derived structure actually
// changed; day-to-day renders just flip aria-pressed on stable buttons, so
// focus and press state survive like they did with the hardcoded markup.
let habitStructureSig = null;

function syncHabitStructure(state, todayIso) {
  const habitList = document.getElementById('habit-list');
  const bonusSection = document.getElementById('bonus-section');
  if (!habitList || !bonusSection) return;

  const settings = state.settings;
  const active = activeHabitsOn(settings.habits, todayIso);
  const weekly = active.filter((h) => h.cadence === 'weekly-quota');
  const cores = active.filter((h) => h.cadence === 'daily-core');
  const bonus = active.filter((h) => h.cadence === 'bonus');
  const threshold = effectiveThreshold(settings.habits, settings.coreSlack, todayIso);

  const sig = JSON.stringify([
    weekly.map((h) => [h.id, rowLabel(h, settings), h.weeklyTarget]),
    cores.map((h) => [h.id, rowLabel(h, settings)]),
    bonus.map((h) => [h.id, rowLabel(h, settings)]),
    threshold,
  ]);
  if (sig === habitStructureSig) return;
  habitStructureSig = sig;

  habitList.innerHTML = '';
  for (const habit of weekly) {
    habitList.appendChild(buildGroupLabel(`Weekly — ${habit.weeklyTarget}×`));
    habitList.appendChild(buildHabitRow(habit, settings));
  }
  if (cores.length > 0) {
    habitList.appendChild(buildGroupLabel(`Daily — ${threshold} of ${cores.length}`));
    for (const habit of cores) {
      habitList.appendChild(buildHabitRow(habit, settings));
    }
  }

  bonusSection.innerHTML = '';
  for (const habit of bonus) {
    bonusSection.appendChild(buildHabitRow(habit, settings));
  }
}

function renderHabitRows(state, todayIso) {
  syncHabitStructure(state, todayIso);

  const entry = state.entries[state.activeDate];
  const habitList = document.getElementById('habit-list');
  const bonusSection = document.getElementById('bonus-section');

  if (habitList) {
    for (const btn of habitList.querySelectorAll('[data-habit]')) {
      setPressed(btn, !!entry?.[btn.dataset.habit]);
    }
  }
  if (bonusSection) {
    for (const btn of bonusSection.querySelectorAll('[data-habit]')) {
      setPressed(btn, !!entry?.[btn.dataset.habit]);
    }
  }

  const offdayChip = document.getElementById('offday-chip');
  if (offdayChip) offdayChip.hidden = !entry?.offDay;

  const noteInput = document.getElementById('note-input');
  if (noteInput && document.activeElement !== noteInput) {
    noteInput.value = entry?.note || '';
  }

  setPressed(document.getElementById('offday-toggle'), !!entry?.offDay);
}

function renderDaySelector(state, todayIso) {
  const selector = document.getElementById('day-selector');
  if (!selector) return;
  const yesterday = addDays(todayIso, -1);
  for (const btn of selector.querySelectorAll('[data-day-offset]')) {
    const offset = Number(btn.dataset.dayOffset);
    const dateForBtn = offset === 0 ? todayIso : yesterday;
    setPressed(btn, state.activeDate === dateForBtn);
  }
}

function renderCumulativeStats(state, todayIso) {
  const el = document.getElementById('cumulative-stats');
  if (!el) return;
  const { habits, coreSlack } = state.settings;
  const stats = cumulativeStats(state.entries, habits, coreSlack, todayIso);
  const counts = habitCounts(state.entries, habits);
  el.innerHTML = '';
  const items = [
    { value: stats.totalLogged, label: 'Days logged' },
    { value: stats.totalCoreHit, label: 'Core-threshold days' },
    // One "Days X" stat per weekly-quota habit active today, in config order
    // (the default config's single `trained` renders as "Days trained").
    ...activeWeeklyHabits(habits, todayIso).map((h) => ({
      value: counts[h.id],
      label: `Days ${h.label.toLowerCase()}`,
    })),
    { value: stats.bestStreak, label: 'Best streak' },
    { value: stats.offDayCount, label: 'Off days' },
    { value: `${stats.last30Hit}/30`, label: 'Last 30 days' },
  ];
  for (const item of items) {
    const stat = document.createElement('div');
    stat.className = 'stat';
    const value = document.createElement('div');
    value.className = 'stat-value';
    value.textContent = String(item.value);
    const label = document.createElement('div');
    label.className = 'stat-label';
    label.textContent = item.label;
    stat.appendChild(value);
    stat.appendChild(label);
    el.appendChild(stat);
  }
}

export function renderToday(state) {
  const todayIso = todayISO();
  renderStreakBlock(state, todayIso);
  renderHabitRows(state, todayIso);
  renderDaySelector(state, todayIso);
  renderCumulativeStats(state, todayIso);
}

// Legend/tooltip name for the weekly-done dot: the habit's own label while
// exactly one weekly-quota habit exists (the default config keeps reading
// "Trained"), generic "Weekly" once there are several.
function weeklyMarkerLabel(habits, todayIso) {
  const weekly = activeWeeklyHabits(habits, todayIso);
  return weekly.length === 1 ? weekly[0].label : 'Weekly';
}

export function renderHistory(state) {
  const grid = document.getElementById('history-grid');
  if (!grid) return;
  const todayIso = todayISO();
  const weekStartsOn = state.settings.weekStartsOn;
  const weeks = historyWeeks(state.entries, state.settings.habits, todayIso, 5, weekStartsOn);
  grid.innerHTML = '';

  const markerLabel = weeklyMarkerLabel(state.settings.habits, todayIso);
  const markerWord = markerLabel.toLowerCase();
  const hasWeekly = activeWeeklyHabits(state.settings.habits, todayIso).length > 0;
  const legendSwatch = document.getElementById('legend-weekly-swatch');
  const legendLabel = document.getElementById('legend-weekly-label');
  if (legendSwatch) legendSwatch.hidden = !hasWeekly;
  if (legendLabel) {
    legendLabel.hidden = !hasWeekly;
    legendLabel.textContent = markerLabel;
  }

  // Column-major grid: first column is weekday labels, then one column per
  // week (first weekday at the top), so weekly rhythm reads across a row.
  for (const label of weekdayLabels(weekStartsOn)) {
    const div = document.createElement('div');
    div.className = 'wd-label';
    div.textContent = label[0];
    div.setAttribute('aria-hidden', 'true');
    grid.appendChild(div);
  }

  for (const week of weeks) {
    for (const cell of week.days) {
      const div = document.createElement('div');
      if (cell.future) {
        div.className = 'cell future';
        grid.appendChild(div);
        continue;
      }
      const intensity = cell.logged ? intensityLevel(cell.count, cell.coreTotal) : 0;
      div.className = `cell i${intensity}`;
      if (cell.offDay) div.classList.add('off');
      if (cell.weeklyDone) div.classList.add('trained');
      const parts = [
        cell.logged ? `${cell.count} of ${cell.coreTotal}` : 'not logged',
        cell.offDay ? 'off day' : '',
        cell.weeklyDone ? markerWord : '',
      ].filter(Boolean);
      const detail = `${monthDay(cell.date)}: ${parts.join(', ')}`;
      div.dataset.detail = detail;
      div.setAttribute('role', 'img');
      div.setAttribute('aria-label', detail);
      grid.appendChild(div);
    }
  }

  renderHabitCounts(state);
}

function renderHabitCounts(state) {
  const el = document.getElementById('habit-counts');
  if (!el) return;
  const habits = state.settings.habits;
  const counts = habitCounts(state.entries, habits);
  el.innerHTML = '';
  // Canonical order, plain counts — deliberately never ranked or judged.
  for (const habit of habits) {
    const row = document.createElement('div');
    row.className = 'habit-count-row';
    if (habit.cadence === 'bonus') {
      row.classList.add('bonus');
    }
    const label = document.createElement('span');
    label.textContent = habit.label;
    const value = document.createElement('span');
    value.className = 'habit-count-value';
    value.textContent = `${counts[habit.id]} days`;
    row.appendChild(label);
    row.appendChild(value);
    el.appendChild(row);
  }
}

const CADENCE_TAGS = {
  'daily-core': 'daily',
  'weekly-quota': 'weekly',
  bonus: 'bonus',
};

function buildEditorRow(habit, openIds) {
  const row = document.createElement('details');
  row.className = 'editor-row';
  row.dataset.habitId = habit.id;
  if (openIds.has(habit.id)) row.open = true;

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'editor-row-name';
  name.textContent = habit.label;
  const tag = document.createElement('span');
  tag.className = 'editor-row-tag';
  tag.textContent = CADENCE_TAGS[habit.cadence];
  summary.appendChild(name);
  summary.appendChild(tag);
  row.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'editor-row-body';

  const labelField = document.createElement('label');
  labelField.className = 'editor-field';
  labelField.textContent = 'Label';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.dataset.field = 'label';
  labelInput.value = habit.label;
  labelInput.autocomplete = 'off';
  labelField.appendChild(labelInput);
  body.appendChild(labelField);

  if (habit.cadence === 'weekly-quota') {
    const targetField = document.createElement('label');
    targetField.className = 'editor-field';
    targetField.textContent = 'Days per week';
    const targetInput = document.createElement('input');
    targetInput.type = 'number';
    targetInput.dataset.field = 'weeklyTarget';
    targetInput.min = '1';
    targetInput.max = '7';
    targetInput.step = '1';
    targetInput.value = habit.weeklyTarget;
    targetField.appendChild(targetInput);
    body.appendChild(targetField);
  }

  const actions = document.createElement('div');
  actions.className = 'editor-actions';
  for (const [action, text, ariaLabel] of [
    ['up', '↑', 'Move up'],
    ['down', '↓', 'Move down'],
    ['archive', 'Archive', ''],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.action = action;
    btn.textContent = text;
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
    actions.appendChild(btn);
  }
  body.appendChild(actions);

  const caption = document.createElement('p');
  caption.className = 'setting-caption';
  caption.textContent = 'Archiving keeps its history — you can bring it back anytime.';
  body.appendChild(caption);

  row.appendChild(body);
  return row;
}

function buildArchivedRow(habit) {
  const row = document.createElement('div');
  row.className = 'archived-row';
  row.dataset.habitId = habit.id;
  const name = document.createElement('span');
  name.className = 'editor-row-name';
  name.textContent = habit.label;
  const tag = document.createElement('span');
  tag.className = 'editor-row-tag';
  tag.textContent = CADENCE_TAGS[habit.cadence];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.action = 'unarchive';
  btn.textContent = 'Unarchive';
  row.appendChild(name);
  row.appendChild(tag);
  row.appendChild(btn);
  return row;
}

// Same rebuild-on-change discipline as the Today card rows: the list DOM is
// rebuilt only when the config actually changed, and expanded rows stay
// expanded across rebuilds.
let editorSig = null;

function renderHabitEditor(state, todayIso) {
  const listEl = document.getElementById('habit-editor-list');
  const archivedEl = document.getElementById('archived-list');
  if (!listEl || !archivedEl) return;

  const settings = state.settings;
  const activeIds = new Set(activeHabitsOn(settings.habits, todayIso).map((h) => h.id));

  const coreTotal = activeCoresOn(settings.habits, todayIso).length;
  const threshold = effectiveThreshold(settings.habits, settings.coreSlack, todayIso);
  const note = document.getElementById('daily-goal-note');
  if (note) {
    note.textContent =
      threshold === null
        ? 'No core habits active — the daily streak is paused.'
        : `Daily goal: ${threshold} of ${coreTotal} core habits.`;
  }
  const slackEl = document.getElementById('set-slack');
  if (slackEl) {
    slackEl.max = Math.max(0, coreTotal - 1);
    if (document.activeElement !== slackEl) slackEl.value = settings.coreSlack;
  }

  const sig = JSON.stringify(
    settings.habits.map((h) => [h.id, h.label, h.cadence, h.weeklyTarget ?? null, activeIds.has(h.id)])
  );
  if (sig === editorSig) return;
  editorSig = sig;

  const openIds = new Set(
    [...listEl.querySelectorAll('details[open]')].map((d) => d.dataset.habitId)
  );

  // Active rows grouped like the Today card (weekly, core, bonus), array
  // order within each group; archived rows in plain array order.
  listEl.innerHTML = '';
  const active = settings.habits.filter((h) => activeIds.has(h.id));
  for (const cadence of ['weekly-quota', 'daily-core', 'bonus']) {
    for (const habit of active.filter((h) => h.cadence === cadence)) {
      listEl.appendChild(buildEditorRow(habit, openIds));
    }
  }

  archivedEl.innerHTML = '';
  for (const habit of settings.habits.filter((h) => !activeIds.has(h.id))) {
    archivedEl.appendChild(buildArchivedRow(habit));
  }
}

export function renderSettingsForm(state) {
  const settings = state.settings;
  const todayIso = todayISO();
  const sleepEl = document.getElementById('set-sleep');
  const ghEnabledEl = document.getElementById('gh-enabled');
  const ghOwnerEl = document.getElementById('gh-owner');
  const ghRepoEl = document.getElementById('gh-repo');
  const ghPathEl = document.getElementById('gh-path');
  const ghTokenEl = document.getElementById('gh-token');

  renderHabitEditor(state, todayIso);

  const holdEl = document.getElementById('set-hold');
  if (holdEl) holdEl.checked = !!settings.holdToComplete;
  if (sleepEl && document.activeElement !== sleepEl) sleepEl.value = settings.sleepTargetTime;
  const weekStartEl = document.getElementById('set-weekstart');
  if (weekStartEl && document.activeElement !== weekStartEl) weekStartEl.value = settings.weekStartsOn;
  if (ghEnabledEl) ghEnabledEl.checked = !!settings.github.enabled;
  if (ghOwnerEl && document.activeElement !== ghOwnerEl) ghOwnerEl.value = settings.github.owner || '';
  if (ghRepoEl && document.activeElement !== ghRepoEl) ghRepoEl.value = settings.github.repo || '';
  if (ghPathEl && document.activeElement !== ghPathEl) ghPathEl.value = settings.github.path || 'data.json';
  if (ghTokenEl && document.activeElement !== ghTokenEl) ghTokenEl.value = settings.github.token || '';
}

export function renderAll(state) {
  renderToday(state);
  renderHistory(state);
  renderSettingsForm(state);
}
