// Bootstrap and event wiring for Momentum. localStorage is the source of
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
  generateHabitId,
  clampSlack,
  clampWeeklyTarget,
} from './habits.js';
import { mergeEntries } from './merge.js';
import { parseImport, countUpdated } from './importer.js';
import { renderAll, renderSyncStatus, renderHabitScreen } from './render.js';
import {
  pull,
  pushNow,
  schedulePush,
  setStatusListener,
  setRemoteUpdateListener,
} from './sync.js';

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
    habitScreen: null, // null | { mode: 'create' } | { mode: 'edit', id }
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
    showView(btn.dataset.view);
    renderAll(state);
  });

  document.getElementById('history-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-detail]');
    if (!cell) return;
    const detailEl = document.getElementById('grid-detail');
    if (detailEl) detailEl.textContent = cell.dataset.detail;
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
      openHabitScreen({ mode: 'edit', id });
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
    openHabitScreen({ mode: 'create' });
  });

  // Empty inputs parse as NaN, not 0, so clearing a field never silently
  // means "zero" — it reads as invalid and the old value is restored.
  function numberOrNaN(value) {
    const s = String(value).trim();
    return s === '' ? NaN : Number(s);
  }

  editorEl.addEventListener('change', (e) => {
    const target = e.target;
    if (target.id !== 'set-slack') return;
    const slack = clampSlack(numberOrNaN(target.value));
    if (slack !== null) {
      // Cap so today's threshold stays >= 1 (typed values can exceed the
      // input's max attribute).
      const coreTotal = activeCoresOn(state.settings.habits, todayISO()).length;
      state.settings.coreSlack = Math.min(slack, Math.max(0, coreTotal - 1));
      persistSettings();
    }
    target.value = state.settings.coreSlack;
  });

  // --- Habit create/edit screen -------------------------------------------
  // Transactional: fields are populated once on open and read back only on
  // Save. Cancel (or any nav tap) discards. Nothing here touches entries.

  function saveHabitScreen() {
    const screen = state.habitScreen;
    if (!screen) return;
    const label = document.getElementById('habit-screen-label').value.trim();
    if (!label) return; // a habit needs a name; stay on the screen
    const settings = state.settings;
    if (screen.mode === 'create') {
      const cadence = document.getElementById('habit-screen-cadence').value;
      const habit = {
        id: generateHabitId(label, settings.habits),
        label,
        cadence,
        active: [{ from: todayISO(), to: null }],
      };
      if (cadence === 'weekly-quota') {
        habit.weeklyTarget =
          clampWeeklyTarget(numberOrNaN(document.getElementById('habit-screen-target').value)) ?? 3;
      }
      settings.habits.push(habit);
    } else {
      const habit = settings.habits.find((h) => h.id === screen.id);
      if (!habit) {
        closeHabitScreen();
        return;
      }
      habit.label = label; // renames touch only the label — the id is permanent
      if (habit.cadence === 'weekly-quota') {
        const targetVal = clampWeeklyTarget(numberOrNaN(document.getElementById('habit-screen-target').value));
        if (targetVal !== null) habit.weeklyTarget = targetVal;
      }
    }
    saveSettings(settings);
    closeHabitScreen();
  }

  document.getElementById('view-habit').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'habit-screen-save') {
      saveHabitScreen();
      return;
    }
    if (btn.id === 'habit-screen-cancel') {
      closeHabitScreen();
      return;
    }
    const screen = state.habitScreen;
    if (!screen || screen.mode !== 'edit') return;
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
        renderHabitScreen(state); // Remove disappears; nothing else changes
        return;
      }
      state.settings.habits = removeHabit(state.settings.habits, screen.id);
      saveSettings(state.settings);
      closeHabitScreen();
    }
  });

  // Choosing "Weekly" while creating reveals the target field — a deliberate
  // selection, never a mid-typing surprise.
  document.getElementById('habit-screen-cadence').addEventListener('change', (e) => {
    const weekly = e.target.value === 'weekly-quota';
    document.getElementById('habit-screen-target').hidden = !weekly;
    document.getElementById('habit-screen-target-label').hidden = !weekly;
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const json = exportString(state.entries, state.settings);
    const filename = `momentum-export-${todayISO()}.json`;
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

  renderAll(state);
  maybeShowMorningRibbon();
  syncOnLoadOrResume();
}

if (typeof document !== 'undefined') {
  init();
}
