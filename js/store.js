// localStorage persistence. This file owns localStorage access; the only
// other module that touches browser globals is persistence.js (read-only
// StorageManager/navigator probes plus the persist() request).

import { migrateSettings, defaultSettings, freshSettings } from './migrate.js';

const ENTRIES_KEY = 'momentum.entries';
const SETTINGS_KEY = 'momentum.settings';
const LAST_OPEN_KEY = 'momentum.lastOpen';
const SYNC_BASE_KEY = 'momentum.syncBase';
const LAST_SHA_KEY = 'momentum.lastSha';

export const DEFAULT_SETTINGS = defaultSettings();

export function loadEntries() {
  try {
    const raw = localStorage.getItem(ENTRIES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveEntries(entries) {
  try {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

// Last-synced snapshot for three-way merges, persisted alongside entries so
// a reload keeps 3-way precision instead of downgrading to two-way merge.
// Crash-window note: entries and base are two separate setItem writes, so a
// crash between them can leave a newer entries map with an older base. That
// resolves as a stale-base 3-way (one-sided edits still win; only a rare
// double-edited field falls back to timestamp order) and heals on the next
// successful sync. Multi-tab note: last writer wins; the next resume merge
// heals divergence. A failed base write (quota) must be treated by callers
// as a silent downgrade to two-way merge, never as synced.
export function loadSyncBase() {
  try {
    const raw = localStorage.getItem(SYNC_BASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSyncBase(entries) {
  try {
    if (entries == null) {
      localStorage.removeItem(SYNC_BASE_KEY);
    } else {
      localStorage.setItem(SYNC_BASE_KEY, JSON.stringify(entries));
    }
    return true;
  } catch {
    return false;
  }
}

export function clearSyncBase() {
  try {
    localStorage.removeItem(SYNC_BASE_KEY);
  } catch {
    // Read-only stub: nothing to clear.
  }
}

export function loadLastSha() {
  try {
    const raw = localStorage.getItem(LAST_SHA_KEY);
    return raw || null;
  } catch {
    return null;
  }
}

export function saveLastSha(sha) {
  try {
    if (sha == null) {
      localStorage.removeItem(LAST_SHA_KEY);
    } else {
      localStorage.setItem(LAST_SHA_KEY, String(sha));
    }
    return true;
  } catch {
    return false;
  }
}

export function clearSyncState() {
  clearSyncBase();
  try {
    localStorage.removeItem(LAST_SHA_KEY);
  } catch {
    // Read-only stub: nothing to clear.
  }
}

// Fresh install: NEITHER settings NOR entries key exists. Entries without
// settings (or any settings blob at all) means real pre-existing data, which
// must always take the migration path — never the wizard's empty config.
export function isFreshInstall() {
  try {
    return localStorage.getItem(SETTINGS_KEY) === null && localStorage.getItem(ENTRIES_KEY) === null;
  } catch {
    return false;
  }
}

export function loadSettings() {
  // Fresh install: empty habits + the wizard pending, persisted immediately.
  // The v1 legacy fabrication (the original 8 default habits) must never run here — it is
  // reserved for storage that actually holds legacy data.
  if (isFreshInstall()) {
    const settings = freshSettings();
    saveSettings(settings);
    return settings;
  }
  let raw = {};
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed === 'object' && parsed !== null) raw = parsed;
    }
  } catch {
    raw = {};
  }
  const { settings, migrated } = migrateSettings(raw);
  if (migrated) saveSettings(settings);
  return settings;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function loadLastOpen() {
  try {
    return localStorage.getItem(LAST_OPEN_KEY) || '';
  } catch {
    return '';
  }
}

export function saveLastOpen(dateIso) {
  try {
    localStorage.setItem(LAST_OPEN_KEY, dateIso);
    return true;
  } catch {
    return false;
  }
}

// Build version, stamped into exports. Must match sw.js's CACHE suffix
// (a test enforces this) so an export says which build wrote it.
export const APP_VERSION = 'v18';

// exportedFrom records the origin+path the export came from, which matters
// when an install moves between origins (each origin has its own storage).
export function exportString(entries, settings, exportedFrom = '') {
  const payload = {
    version: 1,
    appVersion: APP_VERSION,
    exportedFrom,
    exportedAt: new Date().toISOString(),
    entries,
    settings: {
      ...settings,
      github: { ...settings.github, token: '' },
    },
  };
  return JSON.stringify(payload, null, 2);
}
