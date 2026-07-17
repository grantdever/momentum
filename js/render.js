// All DOM painting for Honest Streaks. No event listeners live here — app.js owns
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
  habitHasHistory,
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
  const text = document.createElement('span');
  text.className = 'habit-text';
  const span = document.createElement('span');
  span.className = 'habit-label';
  span.textContent = rowLabel(habit, settings);
  text.appendChild(span);
  // The cue lives where the behavior happens: plan anchor as a faint caption,
  // rendered only when a plan exists — plan-less habits look exactly as before.
  if (habit.plan) {
    const anchor = document.createElement('span');
    anchor.className = 'habit-anchor';
    anchor.textContent = `after I ${habit.plan.anchor}`;
    text.appendChild(anchor);
  }
  btn.appendChild(text);
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
    weekly.map((h) => [h.id, rowLabel(h, settings), h.weeklyTarget, h.plan?.anchor ?? null]),
    cores.map((h) => [h.id, rowLabel(h, settings), h.plan?.anchor ?? null]),
    bonus.map((h) => [h.id, rowLabel(h, settings), h.plan?.anchor ?? null]),
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

// Read-mostly row: tapping the main area opens the habit screen; only the
// reorder arrows act in place.
function buildEditorRow(habit) {
  const row = document.createElement('div');
  row.className = 'editor-row';
  row.dataset.habitId = habit.id;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'editor-row-open';
  open.dataset.action = 'edit';
  const name = document.createElement('span');
  name.className = 'editor-row-name';
  name.textContent = habit.label;
  const tag = document.createElement('span');
  tag.className = 'editor-row-tag';
  tag.textContent = CADENCE_TAGS[habit.cadence];
  open.appendChild(name);
  open.appendChild(tag);
  row.appendChild(open);

  for (const [action, text, ariaLabel] of [
    ['up', '↑', `Move ${habit.label} up`],
    ['down', '↓', `Move ${habit.label} down`],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'editor-row-move';
    btn.dataset.action = action;
    btn.textContent = text;
    btn.setAttribute('aria-label', ariaLabel);
    row.appendChild(btn);
  }

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
// rebuilt only when the config actually changed.
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
    setStepperDisplay(slackEl, settings.coreSlack, 0, Math.max(0, coreTotal - 1));
  }

  const sig = JSON.stringify(
    settings.habits.map((h) => [h.id, h.label, h.cadence, h.weeklyTarget ?? null, activeIds.has(h.id)])
  );
  if (sig === editorSig) return;
  editorSig = sig;

  // Active rows grouped like the Today card (weekly, core, bonus), array
  // order within each group; archived rows in plain array order.
  listEl.innerHTML = '';
  const active = settings.habits.filter((h) => activeIds.has(h.id));
  for (const cadence of ['weekly-quota', 'daily-core', 'bonus']) {
    for (const habit of active.filter((h) => h.cadence === cadence)) {
      listEl.appendChild(buildEditorRow(habit));
    }
  }

  archivedEl.innerHTML = '';
  for (const habit of settings.habits.filter((h) => !activeIds.has(h.id))) {
    archivedEl.appendChild(buildArchivedRow(habit));
  }
}

const CADENCE_DISPLAY = {
  'daily-core': 'Daily core',
  'weekly-quota': 'Weekly',
  bonus: 'Bonus',
};

// Shared stepper display: value text plus disabled state at the range edges.
function setStepperDisplay(valueEl, value, min, max) {
  valueEl.textContent = String(value);
  const wrap = valueEl.closest('.stepper');
  if (!wrap) return;
  const minus = wrap.querySelector('[data-step="-1"]');
  const plus = wrap.querySelector('[data-step="1"]');
  if (minus) minus.disabled = value <= min;
  if (plus) plus.disabled = value >= max;
}

function setTypeCards(pickerEl, selectedCadence, currentCadence) {
  for (const card of pickerEl.querySelectorAll('.type-card')) {
    const isCurrent = currentCadence != null && card.dataset.cadence === currentCadence;
    card.disabled = isCurrent;
    card.classList.toggle('current', isCurrent);
    card.setAttribute('aria-checked', String(card.dataset.cadence === selectedCadence));
  }
}

function setHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}

// Populates the habit create/edit screen from state.habitScreen. Called once
// when the screen opens — never from renderAll — so background renders
// (rollover, sync merges) can't clobber what the user is typing. Everything
// EXCEPT the label input lives in renderHabitScreenControls, which is safe
// to re-run on any control change without touching typed text.
export function renderHabitScreen(state) {
  const screen = state.habitScreen;
  if (!screen) return;
  const isCreate = screen.mode === 'create';
  const habit = isCreate ? null : state.settings.habits.find((h) => h.id === screen.id);
  if (!isCreate && !habit) return;

  const titleEl = document.getElementById('habit-screen-title');
  if (titleEl) titleEl.textContent = isCreate ? 'New habit' : 'Edit habit';

  const labelEl = document.getElementById('habit-screen-label');
  if (labelEl) labelEl.value = isCreate ? '' : habit.label;

  // Plan fields (edit mode only; the group is hidden on create). Populated
  // here once on open, like the label — never from renderHabitScreenControls.
  const anchorEl = document.getElementById('habit-screen-anchor');
  if (anchorEl) anchorEl.value = habit?.plan?.anchor ?? '';
  const copingEl = document.getElementById('habit-screen-coping');
  if (copingEl) copingEl.value = habit?.plan?.coping ?? '';

  renderHabitScreenControls(state);
}

// Everything on the habit screen except the label input: type picker or
// static type row, weekly-target stepper, change-type card, action groups.
// Never writes the label input, so handlers may call it freely mid-typing.
export function renderHabitScreenControls(state) {
  const screen = state.habitScreen;
  if (!screen) return;
  const isCreate = screen.mode === 'create';
  const habit = isCreate ? null : state.settings.habits.find((h) => h.id === screen.id);
  if (!isCreate && !habit) return;

  // Create: card picker. Edit: static type row + quiet change action.
  const pickerEl = document.getElementById('habit-screen-type-picker');
  if (pickerEl) {
    pickerEl.hidden = !isCreate;
    if (isCreate) setTypeCards(pickerEl, screen.cadence);
  }
  const staticEl = document.getElementById('habit-screen-type-static');
  if (staticEl) staticEl.hidden = isCreate;
  const currentEl = document.getElementById('habit-screen-type-current');
  if (currentEl && !isCreate) currentEl.textContent = CADENCE_DISPLAY[habit.cadence];

  // Weekly target stepper: create shows it while Weekly is picked; edit
  // shows it for weekly habits (taps commit immediately).
  const weekly = isCreate ? screen.cadence === 'weekly-quota' : habit.cadence === 'weekly-quota';
  setHidden('habit-screen-target-label', !weekly);
  setHidden('habit-screen-target-stepper', !weekly);
  const targetEl = document.getElementById('habit-screen-target');
  if (targetEl && weekly) {
    setStepperDisplay(targetEl, isCreate ? screen.weeklyTarget : habit.weeklyTarget, 1, 7);
  }

  renderChangeTypeCard(state, habit);

  // Plan group: edit only. The full sentence renders once a plan exists.
  setHidden('habit-screen-plan-group', isCreate);
  const sentenceEl = document.getElementById('habit-screen-plan-sentence');
  if (sentenceEl) {
    const plan = isCreate ? null : habit.plan;
    sentenceEl.hidden = !plan;
    if (plan) sentenceEl.textContent = `After I ${plan.anchor}, I will ${habit.label}.`;
  }

  setHidden('habit-screen-save', !isCreate);
  setHidden('habit-screen-archive-group', isCreate);

  // Remove exists only while the habit has no logged history; once a day is
  // marked done it is absent entirely and Archive is the path (amended D8).
  setHidden('habit-screen-remove-group', isCreate || habitHasHistory(state.entries, habit.id));
}

// The inline change-type confirm card (edit mode): pick a new type (the
// current one is disabled and tagged), see exactly what will happen, then
// one Neutral confirm. Contains no free-typing inputs, so a full re-render
// on every interaction is safe.
function renderChangeTypeCard(state, habit) {
  const card = document.getElementById('change-type-card');
  if (!card) return;
  const screen = state.habitScreen;
  const open = !!(screen && screen.mode === 'edit' && screen.changeType && habit);
  card.hidden = !open;
  if (!open) return;

  const chosen = screen.changeType.cadence;
  const pickerEl = document.getElementById('change-type-picker');
  if (pickerEl) setTypeCards(pickerEl, chosen, habit.cadence);

  const weekly = chosen === 'weekly-quota';
  setHidden('change-type-target-label', !weekly);
  setHidden('change-type-target-stepper', !weekly);
  const targetEl = document.getElementById('change-type-target');
  if (targetEl && weekly) setStepperDisplay(targetEl, screen.changeType.weeklyTarget, 1, 7);

  const noteEl = document.getElementById('change-type-note');
  if (noteEl) {
    noteEl.hidden = !chosen;
    if (chosen) {
      noteEl.textContent =
        `“${habit.label}” keeps its history in Archived. ` +
        `A new ${CADENCE_DISPLAY[chosen].toLowerCase()} habit named “${habit.label}” starts fresh today.`;
    }
  }
  const confirmEl = document.getElementById('change-type-confirm');
  if (confirmEl) confirmEl.disabled = !chosen;
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

// ---------- Setup wizard (#view-onboarding) ----------

export const WIZARD_COPING_DEFAULT = "I'll pick it up the next day — no penalty.";

const WIZARD_DONE_COPY =
  "That's one. Behavior-change research finds two or three small habits tend to stick as well as " +
  'one — sometimes better — as long as each stays small. Want to set up another?';
const WIZARD_DONE_COPY_THIRD =
  'Three is a strong start — more than that tends to compete. You can always add more in Settings.';

// Full wizard paint. Called only on open and on step transitions — never on
// in-step control taps — so it is the one place allowed to write the typed
// inputs (same discipline as renderHabitScreen).
export function renderWizard(state) {
  const w = state.wizard;
  if (!w) return;

  for (const el of document.querySelectorAll('#view-onboarding [data-wizard-step]')) {
    el.hidden = Number(el.dataset.wizardStep) !== w.step;
  }

  if (w.step === 2) {
    document.getElementById('wizard-anchor').value = '';
    document.getElementById('wizard-behavior').value = '';
    document.getElementById('wizard-plain-label').value = '';
    document.getElementById('wizard-coping').value = WIZARD_COPING_DEFAULT;
  }
  if (w.step === 3) {
    // The behavior sentence's residue becomes the label, shown for final trim.
    document.getElementById('wizard-label').value = w.draft.behavior;
  }
  if (w.step === 5) {
    renderWizardDone(state);
  }

  renderWizardControls(state);
}

// Everything except the typed inputs: mode swap, coping reveal, type cards,
// weekly stepper. Safe to re-run on any control tap mid-typing.
export function renderWizardControls(state) {
  const w = state.wizard;
  if (!w) return;

  if (w.step === 2) {
    setHidden('wizard-sentence', w.draft.plain);
    setHidden('wizard-plain', !w.draft.plain);
    const swapEl = document.getElementById('wizard-swap');
    if (swapEl) swapEl.textContent = w.draft.plain ? 'Make it a plan instead' : 'Just name it instead';
    setHidden('wizard-coping-wrap', !w.draft.copingOpen);
    const toggleEl = document.getElementById('wizard-coping-toggle');
    if (toggleEl) toggleEl.setAttribute('aria-expanded', String(w.draft.copingOpen));
  }

  if (w.step === 3) {
    const pickerEl = document.getElementById('wizard-type-picker');
    if (pickerEl) setTypeCards(pickerEl, w.draft.cadence);
    const weekly = w.draft.cadence === 'weekly-quota';
    setHidden('wizard-target-label', !weekly);
    setHidden('wizard-target-stepper', !weekly);
    const targetEl = document.getElementById('wizard-target');
    if (targetEl && weekly) setStepperDisplay(targetEl, w.draft.weeklyTarget, 1, 7);
  }
}

// Step 5: the habit as a real Today row (same builder, preview only), plus
// the encouragement copy — which flips after the third habit, with Go to
// Today taking the primary tier and Add another demoting to quiet.
function renderWizardDone(state) {
  const w = state.wizard;
  const habit = state.settings.habits.find((h) => h.id === w.habitId);

  const previewEl = document.getElementById('wizard-preview');
  if (previewEl) {
    previewEl.innerHTML = '';
    if (habit) {
      const row = buildHabitRow(habit, state.settings);
      row.disabled = true;
      setPressed(row, !!state.entries[todayISO()]?.[habit.id]);
      previewEl.appendChild(row);
    }
  }

  const third = w.created >= 3;
  const copyEl = document.getElementById('wizard-done-copy');
  if (copyEl) copyEl.textContent = third ? WIZARD_DONE_COPY_THIRD : WIZARD_DONE_COPY;

  const addEl = document.getElementById('wizard-add-another');
  const goEl = document.getElementById('wizard-go-today');
  const actionsEl = document.getElementById('wizard-done-actions');
  if (!addEl || !goEl) return;
  addEl.textContent = third ? 'Add another anyway' : 'Add another';
  addEl.className = third ? 'wizard-quiet' : 'primary-action';
  goEl.textContent = 'Go to Today';
  goEl.className = third ? 'primary-action' : 'neutral-btn';
  // The primary reads first: demote the other button to the end.
  if (actionsEl) actionsEl.appendChild(third ? addEl : goEl);
}

export function renderAll(state) {
  renderToday(state);
  renderHistory(state);
  renderSettingsForm(state);
}
