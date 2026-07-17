// Bootstrap and event wiring for Honest Streaks. localStorage is the source of
// truth for the working session; GitHub sync (if enabled) layers on top.

import { todayISO, addDays, WEEK_STARTS } from './dates.js';
import {
  loadEntries,
  saveEntries,
  loadSettings,
  saveSettings,
  exportString,
  loadLastOpen,
  saveLastOpen,
} from './store.js';
import { daySummary, habitHasHistory } from './streaks.js';
import {
  activeCoresOn,
  archiveHabit,
  unarchiveHabit,
  removeHabit,
  moveHabit,
  changeHabitType,
  clampWeeklyTarget,
  createHabit,
  wizardInterval,
  validatePlan,
} from './habits.js';
import { mergeEntries } from './merge.js';
import { parseImport, countUpdated } from './importer.js';
import {
  renderAll,
  renderSyncStatus,
  renderHabitScreen,
  renderHabitScreenControls,
  renderWizard,
  renderWizardControls,
} from './render.js';
import {
  pull,
  pushNow,
  schedulePush,
  setStatusListener,
  setRemoteUpdateListener,
} from './sync.js';
import { initGestures } from './gestures.js';

const TABS = ['today', 'history', 'settings'];

function createEmptyEntry(date, habits) {
  const entry = { date, note: '', offDay: false, updatedAt: new Date().toISOString() };
  for (const habit of habits) entry[habit.id] = false;
  return entry;
}

function hasGithubCreds(gh) {
  return !!(gh && gh.owner && gh.repo && gh.token);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.error('Service worker registration failed', err);
      });
    } catch (err) {
      console.error('Service worker registration failed', err);
    }
  }
}

function init() {
  const state = {
    entries: loadEntries(),
    settings: loadSettings(),
    activeDate: todayISO(),
    currentDate: todayISO(),
    view: 'today',
    // null | { mode: 'create', cadence, weeklyTarget }
    //      | { mode: 'edit', id, changeType: null | { cadence, weeklyTarget } }
    habitScreen: null,
    // null | { freshSession, created, step: 1..5, habitId, draft }
    wizard: null,
  };

  let syncSuspended = false;

  registerServiceWorker();

  function getOrCreate(date) {
    const existing = state.entries[date];
    if (existing) return existing;
    const fresh = createEmptyEntry(date, state.settings.habits);
    state.entries[date] = fresh;
    return fresh;
  }

  function maybeSync() {
    const gh = state.settings.github;
    if (!gh.enabled || !hasGithubCreds(gh) || syncSuspended) return;
    schedulePush(gh, () => state.entries);
  }

  function persistAndRender() {
    saveEntries(state.entries);
    renderAll(state);
    maybeSync();
  }

  function toggleHabit(date, habit) {
    const entry = getOrCreate(date);
    entry[habit] = !entry[habit];
    entry.updatedAt = new Date().toISOString();
    persistAndRender();
  }

  function toggleOffDay(date) {
    const entry = getOrCreate(date);
    entry.offDay = !entry.offDay;
    entry.updatedAt = new Date().toISOString();
    persistAndRender();
  }

  function setNote(date, note) {
    const entry = getOrCreate(date);
    entry.note = note;
    entry.updatedAt = new Date().toISOString();
    saveEntries(state.entries);
    maybeSync();
  }

  function showBanner(message) {
    const banner = document.getElementById('banner');
    if (!banner) return;
    const messageEl = document.getElementById('banner-message');
    if (messageEl) messageEl.textContent = message;
    banner.hidden = false;
  }

  setStatusListener((status, message) => {
    renderSyncStatus(status, message);
  });

  setRemoteUpdateListener((mergedEntries) => {
    state.entries = mergedEntries;
    saveEntries(state.entries);
    renderAll(state);
  });

  let syncInFlight = false;

  async function syncOnLoadOrResume() {
    const gh = state.settings.github;
    if (!gh.enabled || !hasGithubCreds(gh) || syncSuspended || syncInFlight) return;
    syncInFlight = true;
    renderSyncStatus('syncing');
    try {
      const remote = await pull(gh);
      const { merged, localChanged, remoteChanged } = mergeEntries(state.entries, remote.entries);
      if (localChanged) {
        state.entries = merged;
        saveEntries(state.entries);
        renderAll(state);
      }
      if (remoteChanged) {
        schedulePush(gh, () => state.entries);
      } else {
        renderSyncStatus('synced');
      }
    } catch (err) {
      if (err && err.code === 'auth') {
        showBanner('GitHub sync failed — check token in Settings');
        renderSyncStatus('error', 'Authorization failed');
        syncSuspended = true;
      } else if (err && err.code === 'offline') {
        renderSyncStatus('offline');
      } else {
        renderSyncStatus('error', err && err.message);
      }
    } finally {
      syncInFlight = false;
    }
  }

  let ribbonTimer = null;

  function hideRibbon() {
    const ribbon = document.getElementById('morning-ribbon');
    if (ribbon) ribbon.hidden = true;
    if (ribbonTimer) {
      clearTimeout(ribbonTimer);
      ribbonTimer = null;
    }
  }

  // First open of a new day: a passive, positive-only glance at yesterday's
  // chain. Shows nothing when yesterday is unlogged — backfill lives in the
  // Yesterday tab, and this surface must never carry guilt.
  function maybeShowMorningRibbon() {
    const today = todayISO();
    if (loadLastOpen() === today) return;
    saveLastOpen(today);
    const y = daySummary(state.entries, state.settings.habits, addDays(today, -1));
    if (!y.logged) return;
    const ribbon = document.getElementById('morning-ribbon');
    if (!ribbon) return;
    ribbon.textContent = y.offDay
      ? 'yesterday: off day'
      : `yesterday: ${y.count}/${y.coreTotal}${y.trained ? ' · trained' : ''}`;
    ribbon.hidden = false;
    ribbonTimer = setTimeout(hideRibbon, 8000);
  }

  function checkRollover() {
    const today = todayISO();
    if (today === state.currentDate) return false;
    state.currentDate = today;
    state.activeDate = today;
    renderAll(state);
    maybeShowMorningRibbon();
    syncOnLoadOrResume();
    return true;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!checkRollover()) syncOnLoadOrResume();
    } else {
      const gh = state.settings.github;
      if (gh.enabled && hasGithubCreds(gh)) {
        pushNow(gh, state.entries).catch(() => {});
      }
    }
  });

  window.addEventListener('pageshow', checkRollover);
  window.addEventListener('focus', checkRollover);
  setInterval(checkRollover, 60000);

  // Hold-to-complete (settings.holdToComplete, default off): marking a core
  // habit ON requires a ~500ms press; plain tap still un-marks. Keyboard and
  // assistive-tech clicks (no recent pointerdown) always toggle directly.
  const HOLD_MS = 650;
  const HOLD_CANCEL_PX = 10;
  const habitList = document.getElementById('habit-list');
  // Single source of truth for hold duration — the CSS sweep animation reads
  // this so the ring fill always finishes exactly when the toggle fires.
  habitList.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
  let holdTimer = null;
  let holdBtn = null;
  let holdStartX = 0;
  let holdStartY = 0;
  let swallowNextClick = false;
  let lastPointerBtn = null;
  let lastPointerDownAt = 0;

  function cancelHold() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    if (holdBtn) holdBtn.classList.remove('holding');
    holdBtn = null;
  }

  habitList.addEventListener('pointerdown', (e) => {
    swallowNextClick = false;
    if (!state.settings.holdToComplete) return;
    const btn = e.target.closest('.habit-row[data-habit]');
    if (!btn) return;
    lastPointerBtn = btn;
    lastPointerDownAt = Date.now();
    if (btn.getAttribute('aria-pressed') === 'true') return;
    holdBtn = btn;
    holdStartX = e.clientX;
    holdStartY = e.clientY;
    btn.classList.add('holding');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      const target = holdBtn;
      cancelHold();
      swallowNextClick = true;
      hideRibbon();
      toggleHabit(state.activeDate, target.dataset.habit);
    }, HOLD_MS);
  });

  habitList.addEventListener('pointermove', (e) => {
    if (!holdBtn) return;
    if (
      Math.abs(e.clientX - holdStartX) > HOLD_CANCEL_PX ||
      Math.abs(e.clientY - holdStartY) > HOLD_CANCEL_PX
    ) {
      cancelHold();
    }
  });

  habitList.addEventListener('pointerup', cancelHold);
  habitList.addEventListener('pointercancel', cancelHold);

  habitList.addEventListener('click', (e) => {
    const btn = e.target.closest('.habit-row[data-habit]');
    if (!btn) return;
    hideRibbon();
    if (swallowNextClick) {
      swallowNextClick = false;
      return;
    }
    if (
      state.settings.holdToComplete &&
      btn.getAttribute('aria-pressed') !== 'true' &&
      e.detail > 0 &&
      btn === lastPointerBtn &&
      Date.now() - lastPointerDownAt < 700
    ) {
      return; // real pointer tap on an unpressed row: completing requires the hold
    }
    toggleHabit(state.activeDate, btn.dataset.habit);
  });

  document.getElementById('bonus-section').addEventListener('click', (e) => {
    const btn = e.target.closest('.habit-row[data-habit]');
    if (!btn) return;
    toggleHabit(state.activeDate, btn.dataset.habit);
  });

  document.getElementById('offday-toggle').addEventListener('click', () => {
    toggleOffDay(state.activeDate);
  });

  let noteTimer = null;
  document.getElementById('note-input').addEventListener('input', (e) => {
    const value = e.target.value;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = null;
      setNote(state.activeDate, value);
    }, 500);
  });

  document.getElementById('day-selector').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-day-offset]');
    if (!btn) return;
    const offset = Number(btn.dataset.dayOffset);
    state.activeDate = offset === 0 ? todayISO() : addDays(todayISO(), offset);
    renderAll(state);
  });

  // The habit screen is a sub-screen of Settings: not on the nav, and the
  // Settings tab stays highlighted while it is open.
  function showView(view) {
    state.view = view;
    for (const section of document.querySelectorAll('.view')) {
      section.classList.toggle('active', section.id === `view-${view}`);
    }
    const navView = view === 'habit' ? 'settings' : view;
    for (const navBtn of document.querySelectorAll('#nav [data-view]')) {
      navBtn.classList.toggle('active', navBtn.dataset.view === navView);
    }
  }

  // Swipe-driven tab change: same view switch as a nav tap, but the incoming
  // view slides in from the side the finger travelled toward, so movement has
  // direction. `dir` is +1 (rightward tabs) or -1 (leftward).
  function goToTab(view, dir) {
    const el = document.getElementById(`view-${view}`);
    if (el) {
      const cls = dir > 0 ? 'from-right' : 'from-left';
      el.classList.remove('from-right', 'from-left');
      el.classList.add(cls);
      el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
    }
    showView(view);
    renderAll(state);
  }

  function openHabitScreen(screen) {
    state.habitScreen = screen;
    renderHabitScreen(state);
    showView('habit');
    if (screen.mode === 'create') {
      document.getElementById('habit-screen-label').focus();
    }
  }

  function closeHabitScreen() {
    state.habitScreen = null;
    showView('settings');
    renderAll(state);
  }

  document.getElementById('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.habitScreen = null; // leaving the habit screen discards unsaved edits
    if (state.wizard) leaveWizard(); // #setup route: nav taps exit the wizard too
    showView(btn.dataset.view);
    renderAll(state);
  });

  document.getElementById('history-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-detail]');
    if (!cell) return;
    const detailEl = document.getElementById('grid-detail');
    if (!detailEl) return;
    detailEl.textContent = '';
    const summary = document.createElement('span');
    summary.className = 'grid-detail-summary';
    summary.textContent = cell.dataset.detail;
    detailEl.appendChild(summary);
    if (cell.dataset.note) {
      const note = document.createElement('span');
      note.className = 'grid-detail-note';
      note.textContent = cell.dataset.note;
      detailEl.appendChild(note);
    }
  });

  document.getElementById('banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-dismiss]')) {
      document.getElementById('banner').hidden = true;
    }
  });

  function readSettingsFromForm() {
    const settings = state.settings;
    const sleepVal = document.getElementById('set-sleep').value;
    if (sleepVal) settings.sleepTargetTime = sleepVal;
    const weekStartVal = document.getElementById('set-weekstart').value;
    if (WEEK_STARTS.includes(weekStartVal)) settings.weekStartsOn = weekStartVal;
    settings.github.enabled = document.getElementById('gh-enabled').checked;
    settings.github.owner = document.getElementById('gh-owner').value.trim();
    settings.github.repo = document.getElementById('gh-repo').value.trim();
    settings.github.path = document.getElementById('gh-path').value.trim() || 'data.json';
    settings.github.token = document.getElementById('gh-token').value;
    settings.holdToComplete = document.getElementById('set-hold').checked;
  }

  document.getElementById('view-settings').addEventListener('change', (e) => {
    // The habit editor owns its inputs; a whole-form read here must never
    // run on their change events (it would clobber in-progress edit state).
    if (e.target.closest('#habit-editor')) return;
    syncSuspended = false;
    readSettingsFromForm();
    saveSettings(state.settings);
    renderAll(state);
    if (state.settings.github.enabled && hasGithubCreds(state.settings.github)) {
      syncOnLoadOrResume();
    }
  });

  function persistSettings() {
    saveSettings(state.settings);
    renderAll(state);
  }

  const editorEl = document.getElementById('habit-editor');

  editorEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const row = btn.closest('[data-habit-id]');
    if (!row) return;
    const id = row.dataset.habitId;
    const today = todayISO();
    const settings = state.settings;
    if (action === 'edit') {
      openHabitScreen({ mode: 'edit', id, changeType: null });
      return;
    }
    if (action === 'unarchive') {
      settings.habits = settings.habits.map((h) => (h.id === id ? unarchiveHabit(h, today) : h));
    } else if (action === 'up') {
      settings.habits = moveHabit(settings.habits, id, -1, today);
    } else if (action === 'down') {
      settings.habits = moveHabit(settings.habits, id, 1, today);
    } else {
      return;
    }
    persistSettings();
  });

  document.getElementById('new-habit-btn').addEventListener('click', () => {
    openHabitScreen({ mode: 'create', cadence: 'daily-core', weeklyTarget: 3 });
  });

  // Slack stepper: each tap commits immediately; the max keeps today's
  // threshold >= 1. Buttons disable at the edges, so deltas stay in range,
  // but clamp anyway (a stale render must never step out of bounds).
  editorEl.addEventListener('click', (e) => {
    const stepBtn = e.target.closest('.stepper-btn[data-stepper="slack"]');
    if (!stepBtn) return;
    const coreTotal = activeCoresOn(state.settings.habits, todayISO()).length;
    const max = Math.max(0, coreTotal - 1);
    const next = Math.min(max, Math.max(0, state.settings.coreSlack + Number(stepBtn.dataset.step)));
    if (next !== state.settings.coreSlack) {
      state.settings.coreSlack = next;
      persistSettings(); // re-render updates the stepper display + goal note
    }
  });

  // --- Habit create/edit screen -------------------------------------------
  // One commit idiom everywhere: CREATE is transactional — fields are read
  // once when "Add Habit" is tapped, back cancels. EDIT auto-commits per
  // field — label on blur, weekly target per stepper tap — so back (or any
  // nav tap) just leaves; there is nothing to save. Nothing here touches
  // entries.

  function currentEditHabit() {
    const screen = state.habitScreen;
    if (!screen || screen.mode !== 'edit') return null;
    return state.settings.habits.find((h) => h.id === screen.id) || null;
  }

  function addHabitFromScreen() {
    const screen = state.habitScreen;
    if (!screen || screen.mode !== 'create') return;
    const labelEl = document.getElementById('habit-screen-label');
    const label = labelEl.value.trim();
    if (!label) {
      labelEl.focus(); // a habit needs a name; stay on the screen
      return;
    }
    const settings = state.settings;
    const habit = createHabit({
      label,
      cadence: screen.cadence,
      weeklyTarget: screen.weeklyTarget,
      active: [{ from: todayISO(), to: null }],
      habits: settings.habits,
    });
    settings.habits.push(habit);
    saveSettings(settings);
    closeHabitScreen();
  }

  // Auto-commit the label (edit mode): change fires on blur with a new
  // value. Empty reverts to the previous label — a habit always has a name.
  const habitLabelEl = document.getElementById('habit-screen-label');
  habitLabelEl.addEventListener('change', () => {
    const habit = currentEditHabit();
    if (!habit) return; // create mode: the label is read at Add Habit time
    const value = habitLabelEl.value.trim();
    if (!value) {
      habitLabelEl.value = habit.label;
      return;
    }
    habitLabelEl.value = value; // normalize trimmed whitespace
    if (value !== habit.label) {
      habit.label = value; // renames touch only the label — the id is permanent
      persistSettings();
      renderHabitScreenControls(state); // the plan sentence renders the label
    }
  });
  habitLabelEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') habitLabelEl.blur(); // hardware keyboards commit like "done"
  });

  // Plan auto-commit (edit mode): both fields commit on change, like the
  // label. One plan per habit; an empty cue removes the plan (a plan without
  // a cue is just a wish), and validatePlan trims, caps, and drops an empty
  // coping line.
  const planAnchorEl = document.getElementById('habit-screen-anchor');
  const planCopingEl = document.getElementById('habit-screen-coping');

  function commitPlanFromInputs() {
    const habit = currentEditHabit();
    if (!habit) return;
    const plan = validatePlan({ anchor: planAnchorEl.value, coping: planCopingEl.value });
    if (JSON.stringify(plan) !== JSON.stringify(habit.plan ?? null)) {
      if (plan) habit.plan = plan;
      else delete habit.plan;
      persistSettings();
    }
    renderHabitScreenControls(state); // sentence caption reflects the plan
  }

  for (const el of [planAnchorEl, planCopingEl]) {
    el.addEventListener('change', commitPlanFromInputs);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
    });
  }

  function performChangeType() {
    const screen = state.habitScreen;
    const habit = currentEditHabit();
    const ct = screen && screen.changeType;
    if (!habit || !ct || !ct.cadence) return;
    const before = new Set(state.settings.habits.map((h) => h.id));
    state.settings.habits = changeHabitType(
      state.settings.habits,
      habit.id,
      ct.cadence,
      todayISO(),
      ct.weeklyTarget
    );
    const successor = state.settings.habits.find((h) => !before.has(h.id));
    saveSettings(state.settings);
    renderAll(state);
    // Continue editing on the successor — the natural next step after the
    // guided archive-and-recreate.
    if (successor) openHabitScreen({ mode: 'edit', id: successor.id, changeType: null });
    else closeHabitScreen();
  }

  document.getElementById('view-habit').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const screen = state.habitScreen;
    if (!screen) return;

    if (btn.id === 'habit-screen-back') {
      // Create: cancel. Edit: plain leave — auto-commit already saved
      // everything (the input's blur fired before this click).
      closeHabitScreen();
      return;
    }

    if (btn.id === 'habit-screen-save') {
      addHabitFromScreen();
      return;
    }

    // Type cards (create picker and change-type picker share the markup;
    // disabled cards never reach here — the browser drops their clicks).
    const card = btn.closest('.type-card');
    if (card) {
      const picker = card.closest('.type-picker');
      if (picker && picker.id === 'habit-screen-type-picker' && screen.mode === 'create') {
        screen.cadence = card.dataset.cadence;
      } else if (picker && picker.id === 'change-type-picker' && screen.mode === 'edit' && screen.changeType) {
        screen.changeType.cadence = card.dataset.cadence;
      } else {
        return;
      }
      renderHabitScreenControls(state);
      return;
    }

    // Steppers. Create adjusts draft state; edit commits per tap.
    if (btn.classList.contains('stepper-btn')) {
      const delta = Number(btn.dataset.step);
      if (btn.dataset.stepper === 'target') {
        if (screen.mode === 'create') {
          screen.weeklyTarget = clampWeeklyTarget(screen.weeklyTarget + delta) ?? 3;
        } else {
          const habit = currentEditHabit();
          if (!habit || habit.cadence !== 'weekly-quota') return;
          const next = clampWeeklyTarget((habit.weeklyTarget ?? 3) + delta);
          if (next !== null && next !== habit.weeklyTarget) {
            habit.weeklyTarget = next;
            persistSettings();
          }
        }
      } else if (btn.dataset.stepper === 'change-target' && screen.mode === 'edit' && screen.changeType) {
        screen.changeType.weeklyTarget = clampWeeklyTarget(screen.changeType.weeklyTarget + delta) ?? 3;
      } else {
        return;
      }
      renderHabitScreenControls(state);
      return;
    }

    if (screen.mode !== 'edit') return;

    if (btn.id === 'habit-screen-change-type') {
      // Toggle the confirm card; opening starts with no type picked, so the
      // consequence caption and confirm only appear after a deliberate choice.
      screen.changeType = screen.changeType ? null : { cadence: null, weeklyTarget: 3 };
      renderHabitScreenControls(state);
      return;
    }

    if (btn.id === 'change-type-confirm') {
      performChangeType();
      return;
    }

    if (btn.id === 'habit-screen-archive') {
      state.settings.habits = state.settings.habits.map((h) =>
        h.id === screen.id ? archiveHabit(h, todayISO()) : h
      );
      saveSettings(state.settings);
      closeHabitScreen();
    } else if (btn.id === 'habit-screen-remove') {
      // Re-check right before acting: a sync merge could have landed history
      // while the screen was open.
      if (habitHasHistory(state.entries, screen.id)) {
        renderHabitScreenControls(state); // Remove disappears; nothing else changes
        return;
      }
      state.settings.habits = removeHabit(state.settings.habits, screen.id);
      saveSettings(state.settings);
      closeHabitScreen();
    }
  });

  // --- Setup wizard --------------------------------------------------------
  // Five steps in #view-onboarding, one view, step state in state.wizard.
  // Opens on a fresh install (settings.onboarding === 'pending') with the nav
  // hidden — there is nowhere else to go during first-run — or via the
  // #setup hash route on live data, where nav taps exit like the habit
  // screen. The pending flag clears when the wizard finishes or is skipped.

  function newWizardDraft() {
    return { plain: false, copingOpen: false, cadence: 'daily-core', weeklyTarget: 3, behavior: '', plan: null };
  }

  function openWizard(freshSession) {
    state.wizard = { freshSession, created: 0, step: 1, habitId: null, draft: newWizardDraft() };
    document.getElementById('nav').hidden = freshSession;
    renderWizard(state);
    showView('onboarding');
  }

  function clearSetupHash() {
    if (window.location.hash === '#setup') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  // Shared exit: wizard state, hash, nav — without touching the pending flag
  // (nav taps can only reach this on the #setup route, where no flag is set).
  function leaveWizard() {
    state.wizard = null;
    clearSetupHash();
    document.getElementById('nav').hidden = false;
  }

  // Finish or skip: additionally clears the pending flag and lands on Today.
  function finishWizard() {
    if (state.settings.onboarding) {
      delete state.settings.onboarding;
      saveSettings(state.settings);
    }
    leaveWizard();
    showView('today');
    renderAll(state);
  }

  function wizardGoStep(step) {
    state.wizard.step = step;
    renderWizard(state);
  }

  // Step 2 -> 3: read the sentence (or the plain label) into the draft.
  // Sentence path: the cue is required — a plan without a cue is just a wish
  // — and the behavior becomes the label. Missing fields just take focus.
  function wizardReadPlan() {
    const draft = state.wizard.draft;
    if (draft.plain) {
      const labelEl = document.getElementById('wizard-plain-label');
      const label = labelEl.value.trim();
      if (!label) {
        labelEl.focus();
        return;
      }
      draft.behavior = label;
      draft.plan = null;
    } else {
      const anchorEl = document.getElementById('wizard-anchor');
      const behaviorEl = document.getElementById('wizard-behavior');
      const anchor = anchorEl.value.trim();
      const behavior = behaviorEl.value.trim();
      if (!anchor) {
        anchorEl.focus();
        return;
      }
      if (!behavior) {
        behaviorEl.focus();
        return;
      }
      // Coping is stored only when its line was opened (one tap accepts the
      // default). validatePlan later trims, caps, and drops an empty coping.
      const coping = draft.copingOpen ? document.getElementById('wizard-coping').value : '';
      draft.behavior = behavior;
      draft.plan = { anchor, coping };
    }
    wizardGoStep(3);
  }

  // Step 3 -> 4: create the habit for real — same shape the create screen
  // makes, except the interval rule: fresh-install sessions get an open
  // interval (no history to protect on day zero); #setup on existing data
  // activates from today like any other new habit.
  function wizardCreateHabit() {
    const w = state.wizard;
    const labelEl = document.getElementById('wizard-label');
    const label = labelEl.value.trim();
    if (!label) {
      labelEl.focus();
      return;
    }
    const habit = createHabit({
      label,
      cadence: w.draft.cadence,
      weeklyTarget: w.draft.weeklyTarget,
      plan: w.draft.plan,
      active: wizardInterval(w.freshSession, todayISO()),
      habits: state.settings.habits,
    });
    state.settings.habits.push(habit);
    saveSettings(state.settings);
    renderAll(state);
    w.habitId = habit.id;
    w.created += 1;
    wizardGoStep(4);
  }

  document.getElementById('view-onboarding').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !state.wizard) return;
    const w = state.wizard;

    if (btn.id === 'wizard-begin') {
      wizardGoStep(2);
    } else if (btn.id === 'wizard-skip') {
      finishWizard();
    } else if (btn.classList.contains('wizard-chip')) {
      // Chips seed the anchor field; the text stays free to edit.
      document.getElementById('wizard-anchor').value = btn.textContent;
    } else if (btn.id === 'wizard-swap') {
      w.draft.plain = !w.draft.plain;
      renderWizardControls(state);
    } else if (btn.id === 'wizard-coping-toggle') {
      w.draft.copingOpen = !w.draft.copingOpen;
      renderWizardControls(state);
    } else if (btn.id === 'wizard-continue-plan') {
      wizardReadPlan();
    } else if (btn.closest('#wizard-type-picker')) {
      const card = btn.closest('.type-card');
      if (card) {
        w.draft.cadence = card.dataset.cadence;
        renderWizardControls(state);
      }
    } else if (btn.classList.contains('stepper-btn') && btn.dataset.stepper === 'wizard-target') {
      w.draft.weeklyTarget = clampWeeklyTarget(w.draft.weeklyTarget + Number(btn.dataset.step)) ?? 3;
      renderWizardControls(state);
    } else if (btn.id === 'wizard-continue-type') {
      wizardCreateHabit();
    } else if (btn.id === 'wizard-log-today') {
      // The same code path as a Today-card tap: real entry, real streak.
      toggleHabit(todayISO(), w.habitId);
      wizardGoStep(5);
    } else if (btn.id === 'wizard-not-yet') {
      wizardGoStep(5);
    } else if (btn.id === 'wizard-add-another') {
      w.draft = newWizardDraft();
      w.habitId = null;
      wizardGoStep(2);
    } else if (btn.id === 'wizard-go-today') {
      finishWizard();
    }
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const json = exportString(state.entries, state.settings);
    const filename = `honest-streaks-export-${todayISO()}.json`;
    // Standalone iOS web apps handle the share sheet far more reliably than
    // anchor downloads, so prefer it when file sharing is available.
    const file = new File([json], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  function setImportStatus(message) {
    const el = document.getElementById('import-status');
    if (el) el.textContent = message;
  }

  document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // reset so re-selecting the same file fires change again
    if (!file) return;
    const text = await file.text();
    const result = parseImport(text);
    if (result.error) {
      setImportStatus(result.error);
      return;
    }
    const before = state.entries;
    const { merged } = mergeEntries(state.entries, result.entries);
    const updated = countUpdated(before, merged, Object.keys(result.entries));
    state.entries = merged;
    saveEntries(state.entries);
    renderAll(state);
    maybeSync();
    const total = Object.keys(result.entries).length;
    const skippedNote = result.skipped ? `, ${result.skipped} skipped` : '';
    setImportStatus(`Imported — ${total} days merged, ${updated} updated${skippedNote}`);
  });

  initGestures({
    root: document.getElementById('app'),
    canSwipeTabs: () => state.habitScreen == null && TABS.includes(state.view),
    currentTab: () => state.view,
    goToTab,
    sheet: {
      el: document.getElementById('view-habit'),
      scroller: document.getElementById('app'),
      isOpen: () => state.habitScreen != null,
      dismiss: closeHabitScreen,
    },
  });

  renderAll(state);
  maybeShowMorningRibbon();
  syncOnLoadOrResume();

  // First run (fresh install flagged by store.js) or the #setup test route:
  // open the wizard. #setup operates on live config regardless of onboarding
  // state; the hash is cleared on exit so relaunch doesn't re-trigger.
  if (window.location.hash === '#setup' || state.settings.onboarding === 'pending') {
    openWizard(state.settings.onboarding === 'pending');
  }
}

if (typeof document !== 'undefined') {
  init();
}
