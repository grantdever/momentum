// Settings migration: v1 (flat, unversioned) -> v2 (schemaVersion, habits[],
// coreSlack). Pure, total, and idempotent — see schema-design.md D6.

import { WEEK_STARTS } from './dates.js';
import {
  defaultHabits,
  LEGACY_CORE_HABITS,
  RESERVED_KEYS,
  clampSlack,
  clampWeeklyTarget,
  validatePlan,
} from './habits.js';

const ALLOWED_WEEK_STARTS = WEEK_STARTS;
const ALLOWED_CADENCES = ['daily-core', 'weekly-quota', 'bonus'];

// Keys this module understands on a v1 (or v2) raw settings object. Anything
// else is preserved verbatim, the way store.js's old deepMerge did.
const KNOWN_KEYS = [
  'schemaVersion',
  'habits',
  'coreThreshold',
  'gymTargetPerWeek',
  'coreSlack',
  'weekStartsOn',
  'sleepTargetTime',
  'holdToComplete',
  'github',
  'onboarding',
];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return a === b;
}

export function defaultSettings() {
  return {
    schemaVersion: 2,
    habits: defaultHabits(),
    coreSlack: 1,
    weekStartsOn: 'monday',
    sleepTargetTime: '22:00',
    holdToComplete: false,
    github: { enabled: false, owner: '', repo: '', path: 'data.json', token: '' },
  };
}

// Fresh install (neither settings nor entries in storage): schema v2 with
// zero habits and the wizard pending. Deliberately NOT reachable through
// migrateSettings — only store.js's fresh-install detection calls this, so
// any legacy blob still takes the v1 fabrication path byte-identically.
export function freshSettings() {
  return { ...defaultSettings(), habits: [], onboarding: 'pending' };
}

function unknownKeys(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(k)) out[k] = raw[k];
  }
  return out;
}

function validateGithub(gh, fallback) {
  if (!isPlainObject(gh)) return { ...fallback };
  return {
    enabled: typeof gh.enabled === 'boolean' ? gh.enabled : fallback.enabled,
    owner: typeof gh.owner === 'string' ? gh.owner : fallback.owner,
    repo: typeof gh.repo === 'string' ? gh.repo : fallback.repo,
    path: typeof gh.path === 'string' && gh.path ? gh.path : fallback.path,
    token: typeof gh.token === 'string' ? gh.token : fallback.token,
  };
}

function validateInterval(iv) {
  if (!isPlainObject(iv)) return null;
  const from = iv.from === null || typeof iv.from === 'string' ? iv.from : null;
  const to = iv.to === null || typeof iv.to === 'string' ? iv.to : null;
  return { from, to };
}

function validateHabit(h) {
  if (!isPlainObject(h)) return null;
  if (typeof h.id !== 'string' || !h.id) return null;
  // Reserved entry keys must be refused here too, not only in generateHabitId —
  // a habit id like 'date' would let createEmptyEntry overwrite entry fields.
  if (RESERVED_KEYS.includes(h.id)) return null;
  if (typeof h.label !== 'string' || !h.label) return null;
  if (!ALLOWED_CADENCES.includes(h.cadence)) return null;

  const active = Array.isArray(h.active) ? h.active.map(validateInterval).filter(Boolean) : [];
  const habit = {
    id: h.id,
    label: h.label,
    cadence: h.cadence,
    active: active.length > 0 ? active : [{ from: null, to: null }],
  };
  if (h.cadence === 'weekly-quota') {
    habit.weeklyTarget = clampWeeklyTarget(h.weeklyTarget) ?? 3;
  }
  // Optional implementation-intention plan: validated and passed through
  // (this function otherwise strips unknown fields); malformed plans drop.
  const plan = validatePlan(h.plan);
  if (plan) habit.plan = plan;
  return habit;
}

function validateHabitsArray(rawHabits) {
  if (!Array.isArray(rawHabits)) return defaultHabits();
  // An empty array is a legitimate v2 state (fresh install before the wizard
  // adds anything) and must round-trip — the defaults fallback below is only
  // for arrays whose every element failed validation.
  if (rawHabits.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const h of rawHabits) {
    const v = validateHabit(h);
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      out.push(v);
    }
  }
  return out.length > 0 ? out : defaultHabits();
}

// v1 -> v2: build habits[] from the legacy hardcoded set, fold
// coreThreshold -> coreSlack (against LEGACY_CORE_HABITS.length, not a magic
// 5 [R11]) and gymTargetPerWeek -> trained.weeklyTarget.
function migrateFromV1(raw, defaults) {
  const legacyCoreThreshold = Number.isFinite(raw.coreThreshold) ? raw.coreThreshold : 4;
  const coreSlack = clampSlack(LEGACY_CORE_HABITS.length - legacyCoreThreshold) ?? 1;

  const defaultTrained = defaults.habits.find((h) => h.id === 'trained');
  const gymTarget = clampWeeklyTarget(raw.gymTargetPerWeek) ?? defaultTrained.weeklyTarget;

  const habits = defaultHabits().map((h) => (h.id === 'trained' ? { ...h, weeklyTarget: gymTarget } : h));

  return {
    ...unknownKeys(raw),
    schemaVersion: 2,
    habits,
    coreSlack,
    weekStartsOn: ALLOWED_WEEK_STARTS.includes(raw.weekStartsOn) ? raw.weekStartsOn : defaults.weekStartsOn,
    sleepTargetTime:
      typeof raw.sleepTargetTime === 'string' && raw.sleepTargetTime ? raw.sleepTargetTime : defaults.sleepTargetTime,
    holdToComplete: typeof raw.holdToComplete === 'boolean' ? raw.holdToComplete : defaults.holdToComplete,
    github: validateGithub(raw.github, defaults.github),
  };
}

// Already-versioned input: re-validate every field (deepMerge alone lets
// corrupt values like coreThreshold: "banana" through untouched [R6]), still
// preserving unknown keys.
function revalidateV2(raw, defaults) {
  const settings = {
    ...unknownKeys(raw),
    schemaVersion: 2,
    habits: validateHabitsArray(raw.habits),
    coreSlack: clampSlack(raw.coreSlack) ?? defaults.coreSlack,
    weekStartsOn: ALLOWED_WEEK_STARTS.includes(raw.weekStartsOn) ? raw.weekStartsOn : defaults.weekStartsOn,
    sleepTargetTime:
      typeof raw.sleepTargetTime === 'string' && raw.sleepTargetTime ? raw.sleepTargetTime : defaults.sleepTargetTime,
    holdToComplete: typeof raw.holdToComplete === 'boolean' ? raw.holdToComplete : defaults.holdToComplete,
    github: validateGithub(raw.github, defaults.github),
  };
  // Setup-wizard flag: 'pending' is the only stored value ('finished' is the
  // field's absence); anything else drops. v1 blobs never carry it — existing
  // data means there is nothing to onboard (migrateFromV1 ignores the key).
  if (raw.onboarding === 'pending') settings.onboarding = 'pending';
  return settings;
}

// migrateSettings(raw) -> { settings, migrated }. Total (garbage -> defaults),
// idempotent on v2 input, never touches entries.
export function migrateSettings(raw) {
  const defaults = defaultSettings();

  if (!isPlainObject(raw)) {
    return { settings: defaults, migrated: true };
  }

  const isV1 = !Number.isFinite(raw.schemaVersion);
  const settings = isV1 ? migrateFromV1(raw, defaults) : revalidateV2(raw, defaults);
  const migrated = isV1 || !deepEqual(settings, raw);
  return { settings, migrated };
}
