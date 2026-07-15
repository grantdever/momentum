// localStorage persistence. This is the only file in js/ that touches
// localStorage, window, or other browser globals.

import { migrateSettings, defaultSettings } from './migrate.js';

const ENTRIES_KEY = 'momentum.entries';
const SETTINGS_KEY = 'momentum.settings';
const LAST_OPEN_KEY = 'momentum.lastOpen';

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
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
}

export function loadSettings() {
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadLastOpen() {
  try {
    return localStorage.getItem(LAST_OPEN_KEY) || '';
  } catch {
    return '';
  }
}

export function saveLastOpen(dateIso) {
  localStorage.setItem(LAST_OPEN_KEY, dateIso);
}

export function exportString(entries, settings) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
    settings: {
      ...settings,
      github: { ...settings.github, token: '' },
    },
  };
  return JSON.stringify(payload, null, 2);
}
