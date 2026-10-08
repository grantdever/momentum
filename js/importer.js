// Pure JSON-import validation for restoring an Honest Streaks export. No DOM, no
// storage, no fetch. Entries are sanitized day by day; the export's settings
// are re-validated through migrateSettings and then cut down to an allowlist
// of habit definitions and preferences. The `github` block (which can carry a
// token) and any unknown keys are dropped here, so an import can never touch
// sync configuration.

import { migrateSettings } from './migrate.js';

// Settings an import may carry over. Everything else in an export's settings
// (github, onboarding, unknown keys) is dropped at this boundary.
const IMPORTABLE_SETTINGS = ['habits', 'coreSlack', 'weekStartsOn', 'sleepTargetTime', 'holdToComplete'];

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Shared boundary sanitizer used by both the file-import path and the sync
// pull path. Copies only well-formed day entries (date-shaped key holding a
// plain object) into a fresh map, counting rejected keys. Hostile keys
// (prototype-polluting names, non-date keys) and non-object days never reach
// the merge layer or storage.
export function sanitizeEntries(raw) {
  const entries = {};
  let skipped = 0;
  if (!isPlainObject(raw)) return { entries, skipped: 0 };
  for (const [key, value] of Object.entries(raw)) {
    if (DATE_KEY.test(key) && isPlainObject(value)) {
      entries[key] = value;
    } else {
      skipped++;
    }
  }
  return { entries, skipped };
}

export function parseImport(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { error: 'That file is not valid JSON.' };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) {
    return { error: "That file doesn't look like an Honest Streaks export." };
  }

  const { entries, skipped } = sanitizeEntries(parsed.entries);

  if (Object.keys(entries).length === 0) {
    return { error: 'No valid days found in that file.' };
  }

  return { entries, skipped, settings: importableSettings(parsed.settings) };
}

// Re-validate an export's settings blob and keep only the allowlisted keys.
// Returns null when the export carries no settings object at all (entries-only
// files), so callers can tell "no habit definitions" from "zero habits".
export function importableSettings(raw) {
  if (!isPlainObject(raw)) return null;
  const { settings } = migrateSettings(raw);
  const out = {};
  for (const key of IMPORTABLE_SETTINGS) out[key] = settings[key];
  return out;
}

// An empty device has no logged days and no habit definitions — a fresh
// install, before or right after skipping the setup wizard.
export function isEmptyDevice(entries, settings) {
  return Object.keys(entries || {}).length === 0 && (!settings || settings.habits.length === 0);
}

// Decide what an import does to local settings. Pure: returns new settings and
// never mutates its inputs. Entries are merged separately (mergeEntries), so
// this only covers habit definitions and preferences.
//  - Empty device: full restore. Habits come back with their ORIGINAL ids and
//    active intervals (so logged history lines up with them), plus the
//    preferences. Local sync config is kept; the setup-wizard flag clears.
//  - Otherwise: append imported habits whose id is missing locally. Existing
//    local habits (labels, intervals, order) and preferences are never
//    overwritten.
export function planSettingsRestore(localSettings, importedSettings, emptyDevice) {
  const settings = { ...localSettings, habits: localSettings.habits.slice() };
  if (!importedSettings) return { settings, mode: 'entries', habitsAdded: 0 };
  if (emptyDevice) {
    for (const key of IMPORTABLE_SETTINGS) settings[key] = importedSettings[key];
    settings.habits = importedSettings.habits.slice();
    // Only leave the setup wizard when the backup actually brought habits.
    if (settings.habits.length > 0) delete settings.onboarding;
    return { settings, mode: 'full', habitsAdded: settings.habits.length };
  }
  const have = new Set(settings.habits.map((h) => h.id));
  let habitsAdded = 0;
  for (const h of importedSettings.habits) {
    if (!have.has(h.id)) {
      settings.habits.push(h);
      have.add(h.id);
      habitsAdded++;
    }
  }
  return { settings, mode: 'merge', habitsAdded };
}

// "Restored 212 days (2026-03-01–2026-10-05), 6 habits." for the status line.
export function restoreSummary(entries, habitCount) {
  const days = Object.keys(entries).sort();
  const range = days.length ? ` (${days[0]}–${days[days.length - 1]})` : '';
  const dayWord = days.length === 1 ? 'day' : 'days';
  const habitWord = habitCount === 1 ? 'habit' : 'habits';
  return `Restored ${days.length} ${dayWord}${range}, ${habitCount} ${habitWord}.`;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// Count how many of the imported dates actually changed the local entry at
// that date (new days count as changed too) — used for the "N updated"
// status line after an import.
export function countUpdated(before, merged, importedKeys) {
  let count = 0;
  for (const key of importedKeys) {
    if (!deepEqual(before[key], merged[key])) count++;
  }
  return count;
}
