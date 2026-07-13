// localStorage persistence. This is the only file in js/ that touches
// localStorage, window, or other browser globals.

const ENTRIES_KEY = 'momentum.entries';
const SETTINGS_KEY = 'momentum.settings';
const LAST_OPEN_KEY = 'momentum.lastOpen';

export const DEFAULT_SETTINGS = {
  coreThreshold: 4,
  sleepTargetTime: '22:00',
  gymTargetPerWeek: 3,
  weekStartsOn: 'monday',
  github: { enabled: false, owner: '', repo: '', path: 'data.json', token: '' },
};

function deepMerge(defaults, overrides) {
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    return overrides === undefined ? defaults : overrides;
  }
  const out = { ...defaults };
  if (typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)) {
    for (const key of Object.keys(overrides)) {
      if (key in defaults) {
        out[key] = deepMerge(defaults[key], overrides[key]);
      } else {
        out[key] = overrides[key];
      }
    }
  }
  return out;
}

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
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, github: { ...DEFAULT_SETTINGS.github } };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_SETTINGS, github: { ...DEFAULT_SETTINGS.github } };
    }
    return deepMerge(DEFAULT_SETTINGS, parsed);
  } catch {
    return { ...DEFAULT_SETTINGS, github: { ...DEFAULT_SETTINGS.github } };
  }
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
