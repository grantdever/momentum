// Bootstrap and event wiring for Momentum. localStorage is the source of
// truth for the working session; GitHub sync (if enabled) layers on top.

import { todayISO, addDays } from './dates.js';
import {
  loadEntries,
  saveEntries,
  loadSettings,
  saveSettings,
  exportString,
  loadLastOpen,
  saveLastOpen,
} from './store.js';
import { daySummary } from './streaks.js';
import { mergeEntries } from './merge.js';
import { renderAll, renderSyncStatus } from './render.js';
import {
  pull,
  pushNow,
  schedulePush,
  setStatusListener,
  setRemoteUpdateListener,
} from './sync.js';

const HABIT_FIELDS = [
  'trained',
  'alcoholFree',
  'cookedAtHome',
  'sleptOnTime',
  'workSprint',
  'walked',
  'bonusReading',
  'bonusNoGaming',
];

function createEmptyEntry(date) {
  const entry = { date, note: '', offDay: false, updatedAt: new Date().toISOString() };
  for (const field of HABIT_FIELDS) entry[field] = false;
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
  };

  let syncSuspended = false;

  registerServiceWorker();

  function getOrCreate(date) {
    const existing = state.entries[date];
    if (existing) return existing;
    const fresh = createEmptyEntry(date);
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
    const y = daySummary(state.entries, addDays(today, -1));
    if (!y.logged) return;
    const ribbon = document.getElementById('morning-ribbon');
    if (!ribbon) return;
    ribbon.textContent = y.offDay
      ? 'yesterday: off day'
      : `yesterday: ${y.count}/5${y.trained ? ' · trained' : ''}`;
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

  document.getElementById('habit-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.habit-row[data-habit]');
    if (!btn) return;
    hideRibbon();
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

  document.getElementById('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    const view = btn.dataset.view;
    state.view = view;
    for (const section of document.querySelectorAll('.view')) {
      section.classList.toggle('active', section.id === `view-${view}`);
    }
    for (const navBtn of document.querySelectorAll('#nav [data-view]')) {
      navBtn.classList.toggle('active', navBtn.dataset.view === view);
    }
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
    const thresholdVal = Number(document.getElementById('set-threshold').value);
    if (thresholdVal) settings.coreThreshold = thresholdVal;
    const sleepVal = document.getElementById('set-sleep').value;
    if (sleepVal) settings.sleepTargetTime = sleepVal;
    const gymVal = Number(document.getElementById('set-gym').value);
    if (gymVal) settings.gymTargetPerWeek = gymVal;
    settings.github.enabled = document.getElementById('gh-enabled').checked;
    settings.github.owner = document.getElementById('gh-owner').value.trim();
    settings.github.repo = document.getElementById('gh-repo').value.trim();
    settings.github.path = document.getElementById('gh-path').value.trim() || 'data.json';
    settings.github.token = document.getElementById('gh-token').value;
  }

  document.getElementById('view-settings').addEventListener('change', () => {
    syncSuspended = false;
    readSettingsFromForm();
    saveSettings(state.settings);
    renderAll(state);
    if (state.settings.github.enabled && hasGithubCreds(state.settings.github)) {
      syncOnLoadOrResume();
    }
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

  renderAll(state);
  maybeShowMorningRibbon();
  syncOnLoadOrResume();
}

if (typeof document !== 'undefined') {
  init();
}
