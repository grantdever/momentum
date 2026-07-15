import assert from 'node:assert/strict';
import { todayISO, addDays, weekStart } from '../js/dates.js';
import {
  coreCount,
  dailyStreak,
  weeklyQuotaStreak,
  weeklyQuotaProgress,
  cumulativeStats,
  historyGrid,
  historyWeeks,
  habitCounts,
  daySummary,
  intensityLevel,
  weeklyDoneOn,
  habitHasHistory,
} from '../js/streaks.js';
import {
  defaultHabits,
  LEGACY_CORE_HABITS,
  RESERVED_KEYS,
  activeHabitsOn,
  activeCoresOn,
  effectiveThreshold,
  archiveHabit,
  unarchiveHabit,
  generateHabitId,
  clampSlack,
  clampWeeklyTarget,
  moveHabit,
  removeHabit,
  changeHabitType,
} from '../js/habits.js';
import { migrateSettings, defaultSettings } from '../js/migrate.js';
import { mergeEntries } from '../js/merge.js';
import { DEFAULT_SETTINGS, exportString } from '../js/store.js';
import { parseImport, countUpdated } from '../js/importer.js';

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL: ${name}`);
    console.error(err && err.message ? err.message : err);
  }
}

// `defaultMigratedConfig` fixture [R12]: the 8 legacy habits (5 daily-core,
// weekly-quota `trained` at 3, 2 bonus), all open since the beginning, with
// coreSlack 1 — the exact shape migrateSettings produces from a v1 install.
// A fresh copy every call so no test can leak mutation into another.
function freshHabits() {
  return defaultHabits();
}
const CORE_SLACK = 1; // 5 legacy cores - slack 1 = threshold 4, matching every pre-existing test's `threshold: 4`.

function trainedHabit(habits) {
  return habits.find((h) => h.id === 'trained');
}

// Fixture helper: full Entry with all-false defaults.
function e(date, overrides = {}) {
  return {
    date,
    trained: false,
    alcoholFree: false,
    cookedAtHome: false,
    sleptOnTime: false,
    workSprint: false,
    walked: false,
    bonusReading: false,
    bonusNoGaming: false,
    offDay: false,
    note: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// A full core hit (5/5 core habits true).
function hitEntry(date, overrides = {}) {
  return e(date, {
    alcoholFree: true,
    cookedAtHome: true,
    sleptOnTime: true,
    workSprint: true,
    walked: true,
    ...overrides,
  });
}

// ---------- dates.js ----------

t('todayISO formats a fixed local Date', () => {
  const fixed = new Date(2026, 6, 12, 21, 30); // July 12 2026, 9:30pm local
  assert.equal(todayISO(fixed), '2026-07-12');
});

t('addDays across a month boundary', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});

t('addDays across a year boundary', () => {
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
});

t('addDays across US spring-forward DST (2026-03-08 +1)', () => {
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
});

t('addDays across US fall-back DST (2026-11-01 +1)', () => {
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
});

t('weekStart on a Monday is identity', () => {
  assert.equal(weekStart('2026-07-06'), '2026-07-06');
});

t('weekStart on a Sunday is the previous Monday', () => {
  assert.equal(weekStart('2026-07-12'), '2026-07-06');
});

t('weekStart weekday spot-checks (Tue..Sat all map to same Monday)', () => {
  assert.equal(weekStart('2026-07-07'), '2026-07-06'); // Tue
  assert.equal(weekStart('2026-07-08'), '2026-07-06'); // Wed
  assert.equal(weekStart('2026-07-09'), '2026-07-06'); // Thu
  assert.equal(weekStart('2026-07-10'), '2026-07-06'); // Fri
  assert.equal(weekStart('2026-07-11'), '2026-07-06'); // Sat
});

// ---------- habits.js: defaults, effective dating, id generation ----------

t('defaultHabits: 8 legacy habits, 5 daily-core, trained weekly x3, all open', () => {
  const habits = freshHabits();
  assert.equal(habits.length, 8);
  const cores = habits.filter((h) => h.cadence === 'daily-core');
  assert.equal(cores.length, 5);
  assert.deepEqual(
    cores.map((h) => h.id).sort(),
    [...LEGACY_CORE_HABITS].sort()
  );
  const trained = trainedHabit(habits);
  assert.equal(trained.cadence, 'weekly-quota');
  assert.equal(trained.weeklyTarget, 3);
  for (const h of habits) assert.deepEqual(h.active, [{ from: null, to: null }]);
});

t('activeCoresOn: only currently-active daily-core habits count', () => {
  const habits = freshHabits();
  const cores = activeCoresOn(habits, '2026-07-12');
  assert.equal(cores.length, 5);
  assert.ok(cores.every((h) => h.cadence === 'daily-core'));
});

t('effectiveThreshold: max(1, activeCores - slack)', () => {
  const habits = freshHabits();
  assert.equal(effectiveThreshold(habits, 1, '2026-07-12'), 4);
  assert.equal(effectiveThreshold(habits, 0, '2026-07-12'), 5);
});

t('effectiveThreshold: slack greater than active core count clamps to 1, never below', () => {
  const habits = freshHabits();
  assert.equal(effectiveThreshold(habits, 10, '2026-07-12'), 1);
});

t('effectiveThreshold: zero active cores returns null [R1], not an unreachable number', () => {
  const habits = freshHabits().map((h) => (h.cadence === 'daily-core' ? archiveHabit(h, '2026-07-01') : h));
  assert.equal(effectiveThreshold(habits, 1, '2026-07-01'), null);
});

t('archiveHabit / unarchiveHabit: archive closes the open interval, unarchive appends a fresh one', () => {
  let habit = freshHabits().find((h) => h.id === 'walked');
  habit = archiveHabit(habit, '2026-07-10');
  assert.deepEqual(habit.active, [{ from: null, to: '2026-07-10' }]);
  habit = unarchiveHabit(habit, '2026-07-15');
  assert.deepEqual(habit.active, [
    { from: null, to: '2026-07-10' },
    { from: '2026-07-15', to: null },
  ]);
});

t('archiveHabit: is a no-op if already archived', () => {
  let habit = freshHabits().find((h) => h.id === 'walked');
  habit = archiveHabit(habit, '2026-07-10');
  const archivedAgain = archiveHabit(habit, '2026-07-20');
  assert.deepEqual(archivedAgain.active, habit.active);
});

t('effective dating: archive -> unarchive leaves the gap inactive forever', () => {
  let habit = freshHabits().find((h) => h.id === 'walked');
  habit = archiveHabit(habit, '2026-07-10');
  habit = unarchiveHabit(habit, '2026-07-15');
  assert.equal(activeHabitsOn([habit], '2026-07-09').length, 1);
  assert.equal(activeHabitsOn([habit], '2026-07-10').length, 0);
  assert.equal(activeHabitsOn([habit], '2026-07-12').length, 0); // the gap
  assert.equal(activeHabitsOn([habit], '2026-07-15').length, 1);
});

t('effective dating: an archived core leaves the denominator lower starting the next day', () => {
  let habits = freshHabits();
  habits = habits.map((h) => (h.id === 'walked' ? archiveHabit(h, '2026-07-10') : h));
  assert.equal(activeCoresOn(habits, '2026-07-09').length, 5);
  assert.equal(activeCoresOn(habits, '2026-07-10').length, 4);
});

t('effective dating: habit added mid-history does not break earlier days’ streak', () => {
  const habits = [
    ...freshHabits(),
    { id: 'newCore', label: 'New Core', cadence: 'daily-core', active: [{ from: '2026-07-10', to: null }] },
  ];
  const slack = 0; // threshold == active core count that day, to make the effect visible
  const entries = {
    '2026-07-08': hitEntry('2026-07-08'), // only the 5 legacy cores are active; all 5 true
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10', { newCore: true }), // 6 cores active from today; all 6 true
  };
  assert.equal(dailyStreak(entries, habits, slack, '2026-07-10'), 3);
});

t('effective dating: zero active cores on a day acts like an off-day (streak survives)', () => {
  const habits = freshHabits().map((h) => (h.cadence === 'daily-core' ? archiveHabit(h, '2026-07-11') : h));
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': e('2026-07-11'), // zero active cores today: rests, doesn't count, doesn't break
  };
  assert.equal(dailyStreak(entries, habits, 1, '2026-07-11'), 2);
});

t('effective dating: weekly habit added mid-history is not credited for weeks before its start [R9]', () => {
  const habit = {
    id: 'newWeekly',
    label: 'New Weekly',
    cadence: 'weekly-quota',
    weeklyTarget: 2,
    active: [{ from: '2026-07-06', to: null }],
  };
  const entries = {
    // Stray data in weeks before the habit existed that would coincidentally
    // satisfy quota if the walk weren't bounded by the habit's first `from`.
    '2026-06-29': e('2026-06-29', { newWeekly: true }),
    '2026-06-30': e('2026-06-30', { newWeekly: true }), // W-1: 2/2, but pre-dates the habit
    '2026-07-06': e('2026-07-06', { newWeekly: true }),
    '2026-07-07': e('2026-07-07', { newWeekly: true }), // W0: 2/2
  };
  assert.equal(weeklyQuotaStreak(entries, habit, '2026-07-08'), 1);
});

t('generateHabitId: camelCase slug of a fresh label', () => {
  assert.equal(generateHabitId('Cold plunge', []), 'coldPlunge');
});

t('generateHabitId: slug collision gets a numeric suffix', () => {
  const habits = [{ id: 'reading', label: 'Reading', cadence: 'bonus', active: [] }];
  assert.equal(generateHabitId('Reading', habits), 'reading2');
});

t('generateHabitId: dedupes against archived ids, never reissues one [R5]', () => {
  const archivedReading = [
    { id: 'bonusReading', label: 'Bonus Reading', cadence: 'bonus', active: [{ from: null, to: '2026-01-01' }] },
  ];
  // Slug collides with the archived habit's id -> must get a fresh suffix,
  // never grafting new history onto the retired habit's id.
  assert.equal(generateHabitId('Bonus Reading', archivedReading), 'bonusReading2');
});

t('generateHabitId: rejects all 5 reserved keys [R4]', () => {
  for (const key of RESERVED_KEYS) {
    const id = generateHabitId(key, []);
    assert.notEqual(id, key);
  }
});

// changeHabitType never receives entries — the old habit's logged history is
// structurally untouchable from here; only the config array changes.

t('changeHabitType: successor gets a fresh id, same label, new cadence', () => {
  const habits = freshHabits();
  const out = changeHabitType(habits, 'walked', 'bonus', '2026-07-15');
  const old = out.find((h) => h.id === 'walked');
  const successor = out.find((h) => h.label === 'Walked' && h.id !== 'walked');
  assert.ok(old);
  assert.ok(successor);
  assert.notEqual(successor.id, 'walked'); // identical label must still mint a fresh id
  assert.equal(successor.id, 'walked2');
  assert.equal(successor.cadence, 'bonus');
  assert.equal('weeklyTarget' in successor, false); // non-weekly successor carries no target
});

t('changeHabitType: old interval closes at dateIso, successor active from dateIso, inserted adjacent', () => {
  const habits = freshHabits();
  const out = changeHabitType(habits, 'walked', 'bonus', '2026-07-15');
  const old = out.find((h) => h.id === 'walked');
  assert.deepEqual(old.active, [{ from: null, to: '2026-07-15' }]);
  const successor = out.find((h) => h.id === 'walked2');
  assert.deepEqual(successor.active, [{ from: '2026-07-15', to: null }]);
  assert.equal(out.indexOf(successor), out.indexOf(old) + 1);
  assert.equal(out.length, habits.length + 1);
});

t('changeHabitType: weeklyTarget carried for weekly-quota, clamped into 1-7, defaulted when absent', () => {
  const habits = freshHabits();
  const carried = changeHabitType(habits, 'walked', 'weekly-quota', '2026-07-15', 4);
  assert.equal(carried.find((h) => h.id === 'walked2').weeklyTarget, 4);
  const clamped = changeHabitType(habits, 'walked', 'weekly-quota', '2026-07-15', 12);
  assert.equal(clamped.find((h) => h.id === 'walked2').weeklyTarget, 7);
  const defaulted = changeHabitType(habits, 'walked', 'weekly-quota', '2026-07-15');
  assert.equal(defaulted.find((h) => h.id === 'walked2').weeklyTarget, 3);
});

t('changeHabitType: unknown id is a no-op and the input array is never mutated', () => {
  const habits = freshHabits();
  const snapshot = JSON.stringify(habits);
  assert.equal(changeHabitType(habits, 'nope', 'bonus', '2026-07-15'), habits);
  changeHabitType(habits, 'walked', 'bonus', '2026-07-15');
  assert.equal(JSON.stringify(habits), snapshot);
});

// ---------- migrate.js ----------

t('migrateSettings: v1 fixture migrates to the v2 shape', () => {
  const v1 = {
    coreThreshold: 4,
    sleepTargetTime: '23:00',
    gymTargetPerWeek: 4,
    weekStartsOn: 'sunday',
    holdToComplete: true,
    github: { enabled: true, owner: 'someone', repo: 'somewhere', path: 'data.json', token: 'x' },
  };
  const { settings, migrated } = migrateSettings(v1);
  assert.equal(migrated, true);
  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.habits.length, 8);
  assert.equal(settings.coreSlack, 1); // LEGACY_CORE_HABITS.length(5) - 4
  assert.equal(trainedHabit(settings.habits).weeklyTarget, 4);
  assert.equal(settings.weekStartsOn, 'sunday');
  assert.equal(settings.sleepTargetTime, '23:00');
  assert.equal(settings.holdToComplete, true);
  assert.deepEqual(settings.github, v1.github);
  for (const h of settings.habits) assert.deepEqual(h.active, [{ from: null, to: null }]);
});

t('migrateSettings: coreSlack formula uses LEGACY_CORE_HABITS.length, not a magic 5 [R11]', () => {
  const { settings } = migrateSettings({ coreThreshold: 2 });
  assert.equal(settings.coreSlack, LEGACY_CORE_HABITS.length - 2);
});

t('migrateSettings: corrupt coreThreshold falls back to its default, never NaN', () => {
  const { settings } = migrateSettings({ coreThreshold: 'banana' });
  assert.ok(Number.isFinite(settings.coreSlack));
  assert.equal(settings.coreSlack, LEGACY_CORE_HABITS.length - 4); // 4 is the v1 default threshold
});

t('migrateSettings: idempotent on v2 input', () => {
  const first = migrateSettings({});
  const second = migrateSettings(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);
});

t('migrateSettings: habits with reserved-key ids are rejected in validation [R4]', () => {
  const good = { id: 'coldPlunge', label: 'Cold plunge', cadence: 'daily-core', active: [{ from: null, to: null }] };
  const bad = { id: 'date', label: 'Sneaky', cadence: 'daily-core', active: [{ from: null, to: null }] };
  const { settings } = migrateSettings({ schemaVersion: 2, habits: [good, bad], coreSlack: 0 });
  assert.deepEqual(settings.habits.map((h) => h.id), ['coldPlunge']);
});

t('migrateSettings: garbage (non-object) input falls back to total defaults', () => {
  const { settings, migrated } = migrateSettings('banana');
  assert.equal(migrated, true);
  assert.deepEqual(settings, defaultSettings());
});

t('migrateSettings: null input falls back to total defaults', () => {
  const { settings, migrated } = migrateSettings(null);
  assert.equal(migrated, true);
  assert.equal(settings.schemaVersion, 2);
});

t('migrateSettings: preserves unknown keys', () => {
  const { settings } = migrateSettings({ someFutureField: 'kept' });
  assert.equal(settings.someFutureField, 'kept');
});

t('migrateSettings: v2 input with a corrupt enum field falls back per-field, not wholesale', () => {
  const v2 = { ...defaultSettings(), weekStartsOn: 'tuesday' };
  const { settings, migrated } = migrateSettings(v2);
  assert.equal(settings.weekStartsOn, 'monday');
  assert.equal(migrated, true);
});

t('migrateSettings: v2 input with a garbage habits array falls back to defaults', () => {
  const v2 = { ...defaultSettings(), habits: 'nope' };
  const { settings } = migrateSettings(v2);
  assert.equal(settings.habits.length, 8);
});

t('migrateSettings: never touches entries (no entries key in its signature or output)', () => {
  const { settings } = migrateSettings({ coreThreshold: 4 });
  assert.ok(!('entries' in settings));
});

// ---------- streaks.js: coreCount ----------

t('coreCount excludes trained', () => {
  const habits = freshHabits();
  const entry = hitEntry('2026-07-12', { trained: true });
  assert.equal(coreCount(entry, habits, '2026-07-12'), 5);
  assert.ok(!LEGACY_CORE_HABITS.includes('trained'));
});

t('coreCount counts partial core hits', () => {
  const habits = freshHabits();
  const entry = e('2026-07-12', { alcoholFree: true, cookedAtHome: true, sleptOnTime: true });
  assert.equal(coreCount(entry, habits, '2026-07-12'), 3);
});

// ---------- streaks.js: dailyStreak ----------

t('dailyStreak: today unlogged + 3-day prior chain -> 3 (grace)', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 3);
});

t('dailyStreak: today logged & hit adds +1 to prior chain', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
    '2026-07-12': hitEntry('2026-07-12'),
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 4);
});

t('dailyStreak: today logged below threshold neither counts nor breaks', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
    '2026-07-12': e('2026-07-12', { alcoholFree: true, cookedAtHome: true }), // count=2
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 3);
});

t('dailyStreak: yesterday missing breaks chain (today grace still counts)', () => {
  const entries = {
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-12': hitEntry('2026-07-12'),
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 1);
});

t('dailyStreak: backfilling yesterday repairs the chain', () => {
  const entries = {
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
    '2026-07-12': hitEntry('2026-07-12'),
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 3);
});

t('dailyStreak: off-day bridge (hit, off, off, hit) spans to streak 2', () => {
  const entries = {
    '2026-07-08': hitEntry('2026-07-08'),
    '2026-07-09': e('2026-07-09', { offDay: true }),
    '2026-07-10': e('2026-07-10', { offDay: true }),
    '2026-07-11': hitEntry('2026-07-11'),
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 2);
});

t('dailyStreak: all off days -> 0', () => {
  const entries = {
    '2026-07-09': e('2026-07-09', { offDay: true }),
    '2026-07-10': e('2026-07-10', { offDay: true }),
    '2026-07-11': e('2026-07-11', { offDay: true }),
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 0);
});

t('dailyStreak: logged-but-missed past day breaks the chain', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': e('2026-07-10', { alcoholFree: true }), // count=1, below threshold
    '2026-07-11': hitEntry('2026-07-11'),
  };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 1);
});

t('dailyStreak: empty entries -> 0', () => {
  assert.equal(dailyStreak({}, freshHabits(), CORE_SLACK, '2026-07-12'), 0);
});

t('dailyStreak: first-ever day logged & hit -> 1', () => {
  const entries = { '2026-07-12': hitEntry('2026-07-12') };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 1);
});

t('dailyStreak: threshold respected - exactly 4 of 5 passes at threshold 4', () => {
  const entry = e('2026-07-12', {
    alcoholFree: true,
    cookedAtHome: true,
    sleptOnTime: true,
    workSprint: true,
  });
  const entries = { '2026-07-11': entry, '2026-07-12': hitEntry('2026-07-12') };
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 2);
});

t('dailyStreak: threshold respected - 3 of 5 fails at threshold 4', () => {
  const entry = e('2026-07-11', {
    alcoholFree: true,
    cookedAtHome: true,
    sleptOnTime: true,
  });
  const entries = { '2026-07-11': entry, '2026-07-12': hitEntry('2026-07-12') };
  // today hits -> +1; yesterday (3/5) is below threshold -> breaks.
  assert.equal(dailyStreak(entries, freshHabits(), CORE_SLACK, '2026-07-12'), 1);
});

// ---------- streaks.js: weeklyQuotaStreak (was weeklyTrainingStreak) ----------
// Weeks (Mon-Sun): W0 = 07-06..07-12, W-1 = 06-29..07-05, W-2 = 06-22..06-28, W-3 = 06-15..06-21

t('weeklyQuotaStreak: in-progress week under quota does not break prior streak', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }), // W0: 1/3, in progress
    '2026-06-29': e('2026-06-29', { trained: true }),
    '2026-06-30': e('2026-06-30', { trained: true }),
    '2026-07-01': e('2026-07-01', { trained: true }), // W-1: 3/3
    '2026-06-22': e('2026-06-22', { trained: true }),
    '2026-06-23': e('2026-06-23', { trained: true }),
    '2026-06-24': e('2026-06-24', { trained: true }), // W-2: 3/3
    '2026-06-15': e('2026-06-15', { trained: true }), // W-3: 1/3, completed -> breaks
  };
  assert.equal(weeklyQuotaStreak(entries, trainedHabit(freshHabits()), '2026-07-08'), 2);
});

t('weeklyQuotaStreak: in-progress week at quota adds to streak', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }),
    '2026-07-07': e('2026-07-07', { trained: true }),
    '2026-07-08': e('2026-07-08', { trained: true }), // W0: 3/3
    '2026-06-29': e('2026-06-29', { trained: true }),
    '2026-06-30': e('2026-06-30', { trained: true }),
    '2026-07-01': e('2026-07-01', { trained: true }), // W-1: 3/3
    '2026-06-22': e('2026-06-22', { trained: true }),
    '2026-06-23': e('2026-06-23', { trained: true }),
    '2026-06-24': e('2026-06-24', { trained: true }), // W-2: 3/3
  };
  assert.equal(weeklyQuotaStreak(entries, trainedHabit(freshHabits()), '2026-07-08'), 3);
});

t('weeklyQuotaStreak: completed week below quota breaks', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }),
    '2026-07-07': e('2026-07-07', { trained: true }),
    '2026-07-08': e('2026-07-08', { trained: true }), // W0: 3/3
    '2026-06-29': e('2026-06-29', { trained: true }), // W-1: 1/3, completed -> breaks
  };
  assert.equal(weeklyQuotaStreak(entries, trainedHabit(freshHabits()), '2026-07-08'), 1);
});

t('weeklyQuotaStreak: completed week with zero entries breaks', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }),
    '2026-07-07': e('2026-07-07', { trained: true }),
    '2026-07-08': e('2026-07-08', { trained: true }), // W0: 3/3
    '2026-06-15': e('2026-06-15', { trained: true }), // W-3 has an entry so earliest reaches back, W-1/W-2 empty
  };
  assert.equal(weeklyQuotaStreak(entries, trainedHabit(freshHabits()), '2026-07-08'), 1);
});

t('weeklyQuotaStreak: trained on an off day still counts toward quota', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true, offDay: true }),
    '2026-07-07': e('2026-07-07', { trained: true, offDay: true }),
    '2026-07-08': e('2026-07-08', { trained: true, offDay: true }),
  };
  assert.equal(weeklyQuotaStreak(entries, trainedHabit(freshHabits()), '2026-07-08'), 1);
});

t('weeklyQuotaStreak: week boundary - Sunday belongs to its own week, not the next Monday', () => {
  const entries = {
    '2026-07-12': e('2026-07-12', { trained: true }), // Sunday of W0
    '2026-07-06': e('2026-07-06', { trained: true }),
    '2026-07-07': e('2026-07-07', { trained: true }), // W0 total 3/3 incl. Sunday
    '2026-07-13': e('2026-07-13', { trained: true }), // next Monday, W+1, not counted for W0
  };
  assert.equal(weeklyQuotaStreak(entries, trainedHabit(freshHabits()), '2026-07-12'), 1);
});

// ---------- streaks.js: weeklyQuotaProgress (was weekProgress) ----------

t('weeklyQuotaProgress: correct count and Mon..Sun boolean placement', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }), // Mon
    '2026-07-09': e('2026-07-09', { trained: true }), // Thu
  };
  const result = weeklyQuotaProgress(entries, trainedHabit(freshHabits()), '2026-07-08'); // Wed, same week
  assert.equal(result.count, 2);
  assert.deepEqual(result.days, [true, false, false, true, false, false, false]);
});

// ---------- streaks.js: cumulativeStats ----------

t('cumulativeStats: bestStreak survives off-days and resets on a gap', () => {
  const entries = {
    '2026-07-01': hitEntry('2026-07-01'),
    '2026-07-02': hitEntry('2026-07-02'),
    '2026-07-03': e('2026-07-03', { offDay: true }),
    '2026-07-04': hitEntry('2026-07-04'), // run of 3 so far (best=3)
    // gap at 07-05 -> run resets
    '2026-07-06': hitEntry('2026-07-06'),
  };
  const stats = cumulativeStats(entries, freshHabits(), CORE_SLACK, '2026-07-06');
  assert.equal(stats.bestStreak, 3);
});

t('cumulativeStats: totals correct', () => {
  const entries = {
    '2026-07-01': hitEntry('2026-07-01', { trained: true }),
    '2026-07-02': e('2026-07-02', { alcoholFree: true }), // below threshold
    '2026-07-03': e('2026-07-03', { offDay: true }),
  };
  const stats = cumulativeStats(entries, freshHabits(), CORE_SLACK, '2026-07-03');
  assert.equal(stats.totalLogged, 3);
  assert.equal(stats.totalCoreHit, 1);
  assert.equal(stats.totalTrained, 1);
});

// ---------- streaks.js: historyGrid ----------

t('historyGrid: length n, oldest-first, correct flags', () => {
  const entries = {
    '2026-07-10': hitEntry('2026-07-10', { trained: true }),
    '2026-07-11': e('2026-07-11', { offDay: true }),
  };
  const grid = historyGrid(entries, freshHabits(), '2026-07-12', 5);
  assert.equal(grid.length, 5);
  assert.equal(grid[0].date, '2026-07-08');
  assert.equal(grid[4].date, '2026-07-12');

  const missingDay = grid.find((d) => d.date === '2026-07-09');
  assert.equal(missingDay.logged, false);
  assert.equal(missingDay.count, 0);

  const hitDay = grid.find((d) => d.date === '2026-07-10');
  assert.equal(hitDay.logged, true);
  assert.equal(hitDay.count, 5);
  assert.equal(hitDay.weeklyDone, true);
  assert.equal(hitDay.offDay, false);

  const offDayEntry = grid.find((d) => d.date === '2026-07-11');
  assert.equal(offDayEntry.offDay, true);
  assert.equal(offDayEntry.logged, true);
});

// ---------- merge.js ----------

t('mergeEntries: remote newer wins', () => {
  const local = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T10:00:00.000Z', note: 'local' }) };
  const remote = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T12:00:00.000Z', note: 'remote' }) };
  const { merged } = mergeEntries(local, remote);
  assert.equal(merged['2026-07-01'].note, 'remote');
});

t('mergeEntries: local newer wins', () => {
  const local = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T12:00:00.000Z', note: 'local' }) };
  const remote = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T10:00:00.000Z', note: 'remote' }) };
  const { merged } = mergeEntries(local, remote);
  assert.equal(merged['2026-07-01'].note, 'local');
});

t('mergeEntries: disjoint keys union', () => {
  const local = { '2026-07-01': e('2026-07-01') };
  const remote = { '2026-07-02': e('2026-07-02') };
  const { merged } = mergeEntries(local, remote);
  assert.deepEqual(Object.keys(merged).sort(), ['2026-07-01', '2026-07-02']);
});

t('mergeEntries: tie on updatedAt -> local wins', () => {
  const local = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T10:00:00.000Z', note: 'local' }) };
  const remote = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T10:00:00.000Z', note: 'remote' }) };
  const { merged } = mergeEntries(local, remote);
  assert.equal(merged['2026-07-01'].note, 'local');
});

t('mergeEntries: identical inputs -> both flags false', () => {
  const local = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T10:00:00.000Z' }) };
  const remote = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T10:00:00.000Z' }) };
  const { localChanged, remoteChanged } = mergeEntries(local, remote);
  assert.equal(localChanged, false);
  assert.equal(remoteChanged, false);
});

t('mergeEntries: remote-only additions -> localChanged true, remoteChanged false', () => {
  const local = {};
  const remote = { '2026-07-01': e('2026-07-01') };
  const { localChanged, remoteChanged } = mergeEntries(local, remote);
  assert.equal(localChanged, true);
  assert.equal(remoteChanged, false);
});

t('mergeEntries: local-only additions -> remoteChanged true, localChanged false', () => {
  const local = { '2026-07-01': e('2026-07-01') };
  const remote = {};
  const { localChanged, remoteChanged } = mergeEntries(local, remote);
  assert.equal(remoteChanged, true);
  assert.equal(localChanged, false);
});

t('mergeEntries: inputs are not mutated', () => {
  const local = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T10:00:00.000Z', note: 'local' }) };
  const remote = { '2026-07-01': e('2026-07-01', { updatedAt: '2026-07-01T12:00:00.000Z', note: 'remote' }) };
  const localSnapshot = JSON.parse(JSON.stringify(local));
  const remoteSnapshot = JSON.parse(JSON.stringify(remote));
  mergeEntries(local, remote);
  assert.deepEqual(local, localSnapshot);
  assert.deepEqual(remote, remoteSnapshot);
});

// --- v1.1 additive stats -------------------------------------------------

function hit(date, overrides = {}) {
  return e(date, {
    alcoholFree: true, cookedAtHome: true, sleptOnTime: true, workSprint: true,
    ...overrides,
  });
}

t('cumulativeStats: offDayCount counts off days', () => {
  const entries = {
    '2026-07-01': e('2026-07-01', { offDay: true }),
    '2026-07-02': hit('2026-07-02'),
    '2026-07-03': e('2026-07-03', { offDay: true }),
  };
  assert.equal(cumulativeStats(entries, freshHabits(), CORE_SLACK, '2026-07-03').offDayCount, 2);
});

t('cumulativeStats: last30Hit counts threshold days in trailing 30-day window', () => {
  const entries = {
    '2026-07-12': hit('2026-07-12'),
    '2026-07-10': hit('2026-07-10'),
    '2026-07-05': e('2026-07-05'),                    // logged, below threshold
    '2026-07-03': hit('2026-07-03', { offDay: true }), // off day never hits
  };
  assert.equal(cumulativeStats(entries, freshHabits(), CORE_SLACK, '2026-07-12').last30Hit, 2);
});

t('cumulativeStats: last30Hit window boundary — day 29 back counts, day 30 back does not', () => {
  const today = '2026-07-12';
  const entries = {
    [addDays(today, -29)]: hit(addDays(today, -29)),
    [addDays(today, -30)]: hit(addDays(today, -30)),
  };
  assert.equal(cumulativeStats(entries, freshHabits(), CORE_SLACK, today).last30Hit, 1);
});

t('historyWeeks: 5 weeks, Monday-aligned, oldest first, ends with current week', () => {
  const today = '2026-07-12'; // a Sunday; week is Mon 2026-07-06 .. Sun 2026-07-12
  const wk = historyWeeks({}, freshHabits(), today);
  assert.equal(wk.length, 5);
  assert.equal(wk[4].start, '2026-07-06');
  assert.equal(wk[0].start, '2026-06-08');
  for (const w of wk) {
    assert.equal(w.days.length, 7);
    assert.equal(w.days[0].date, w.start);
    assert.equal(weekStart(w.days[6].date), w.start);
  }
});

t('historyWeeks: future flags only after today within current week', () => {
  const today = '2026-07-08'; // Wednesday; Thu-Sun of current week are future
  const wk = historyWeeks({}, freshHabits(), today);
  const current = wk[4];
  assert.deepEqual(current.days.map((d) => d.future),
    [false, false, false, true, true, true, true]);
  assert.ok(wk[3].days.every((d) => !d.future));
});

t('historyWeeks: cell flags for logged/off/weeklyDone and month-boundary dates', () => {
  const entries = {
    '2026-06-30': hit('2026-06-30', { trained: true }),
    '2026-07-01': e('2026-07-01', { offDay: true }),
  };
  const wk = historyWeeks(entries, freshHabits(), '2026-07-12');
  const flat = wk.flatMap((w) => w.days);
  const juneCell = flat.find((d) => d.date === '2026-06-30');
  const julyCell = flat.find((d) => d.date === '2026-07-01');
  assert.ok(juneCell.logged && juneCell.weeklyDone && juneCell.count === 4);
  assert.ok(julyCell.logged && julyCell.offDay && !julyCell.weeklyDone);
  const unlogged = flat.find((d) => d.date === '2026-07-02');
  assert.ok(!unlogged.logged && unlogged.count === 0);
});

// --- per-habit counts ------------------------------------------------------

t('habitCounts: empty entries -> all zeros for all 8 habits', () => {
  const habits = freshHabits();
  const counts = habitCounts({}, habits);
  assert.equal(Object.keys(counts).length, habits.length);
  for (const h of habits) assert.equal(counts[h.id], 0);
});

t('habitCounts: counts true fields across entries', () => {
  const entries = {
    '2026-07-01': e('2026-07-01', { walked: true, trained: true }),
    '2026-07-02': e('2026-07-02', { walked: true, bonusReading: true }),
    '2026-07-03': e('2026-07-03', { alcoholFree: true }),
  };
  const counts = habitCounts(entries, freshHabits());
  assert.equal(counts.walked, 2);
  assert.equal(counts.trained, 1);
  assert.equal(counts.bonusReading, 1);
  assert.equal(counts.alcoholFree, 1);
  assert.equal(counts.cookedAtHome, 0);
});

t('habitCounts: off-day entries still counted (descriptive, not judged)', () => {
  const entries = {
    '2026-07-01': e('2026-07-01', { walked: true, offDay: true }),
  };
  assert.equal(habitCounts(entries, freshHabits()).walked, 1);
});

// --- morning ribbon summary ------------------------------------------------

t('daySummary: logged day reports count, trained, offDay', () => {
  const entries = {
    '2026-07-11': hitEntry('2026-07-11', { trained: true }),
  };
  const s = daySummary(entries, freshHabits(), '2026-07-11');
  assert.deepEqual(s, { logged: true, count: 5, coreTotal: 5, trained: true, offDay: false });
});

t('daySummary: off day reported as off with its count', () => {
  const entries = {
    '2026-07-11': e('2026-07-11', { offDay: true, walked: true }),
  };
  const s = daySummary(entries, freshHabits(), '2026-07-11');
  assert.ok(s.logged && s.offDay);
  assert.equal(s.count, 1);
});

t('daySummary: unlogged day -> logged false, zeros', () => {
  const s = daySummary({}, freshHabits(), '2026-07-11');
  assert.deepEqual(s, { logged: false, count: 0, coreTotal: 5, trained: false, offDay: false });
});

// --- stage 2: day-scoped denominators and intensity ratios ------------------

t('daySummary: coreTotal reflects that day\'s active cores, not the config size', () => {
  const habits = freshHabits().map((h) => (h.id === 'walked' ? archiveHabit(h, '2026-07-10') : h));
  assert.equal(daySummary({}, habits, '2026-07-09').coreTotal, 5);
  assert.equal(daySummary({}, habits, '2026-07-10').coreTotal, 4);
});

t('intensityLevel: identity on the default 5-core config', () => {
  for (let k = 0; k <= 5; k++) {
    assert.equal(intensityLevel(k, 5), k);
  }
});

t('intensityLevel: scales counts onto the 6-step ramp for non-5 core totals', () => {
  // 3 cores: 0, ~2, ~3, 5 — full hit always lands on the top color.
  assert.equal(intensityLevel(0, 3), 0);
  assert.equal(intensityLevel(1, 3), 2);
  assert.equal(intensityLevel(2, 3), 3);
  assert.equal(intensityLevel(3, 3), 5);
  // 8 cores: any nonzero count shows at least i1.
  assert.equal(intensityLevel(1, 8), 1);
  assert.equal(intensityLevel(4, 8), 3);
  assert.equal(intensityLevel(8, 8), 5);
});

t('intensityLevel: zero core total or zero count -> 0; never exceeds 5', () => {
  assert.equal(intensityLevel(0, 5), 0);
  assert.equal(intensityLevel(3, 0), 0);
  assert.equal(intensityLevel(7, 5), 5);
});

t('historyGrid: cells carry that day\'s coreTotal across an archive boundary', () => {
  const habits = freshHabits().map((h) => (h.id === 'walked' ? archiveHabit(h, '2026-07-11') : h));
  const grid = historyGrid({}, habits, '2026-07-12', 4);
  const byDate = Object.fromEntries(grid.map((c) => [c.date, c.coreTotal]));
  assert.equal(byDate['2026-07-09'], 5);
  assert.equal(byDate['2026-07-10'], 5);
  assert.equal(byDate['2026-07-11'], 4); // `to` is exclusive: archived from this day on
  assert.equal(byDate['2026-07-12'], 4);
});

t('historyWeeks: cells carry coreTotal (default config -> 5 everywhere)', () => {
  const wk = historyWeeks({}, freshHabits(), '2026-07-12');
  for (const w of wk) {
    for (const d of w.days) assert.equal(d.coreTotal, 5);
  }
});

// --- stage 3: clamps, reorder, any-weekly dot --------------------------------

t('clampSlack: integers >= 0; garbage -> null', () => {
  assert.equal(clampSlack(-3), 0);
  assert.equal(clampSlack(0), 0);
  assert.equal(clampSlack(2.7), 2);
  assert.equal(clampSlack(4), 4);
  assert.equal(clampSlack(NaN), null);
  assert.equal(clampSlack('banana'), null);
  assert.equal(clampSlack(Infinity), null);
});

t('clampWeeklyTarget: integers 1-7; garbage -> null', () => {
  assert.equal(clampWeeklyTarget(0), 1);
  assert.equal(clampWeeklyTarget(-2), 1);
  assert.equal(clampWeeklyTarget(3.9), 3);
  assert.equal(clampWeeklyTarget(7), 7);
  assert.equal(clampWeeklyTarget(99), 7);
  assert.equal(clampWeeklyTarget(NaN), null);
  assert.equal(clampWeeklyTarget('banana'), null);
});

t('migrateSettings: negative or fractional coreSlack on v2 input is clamped, not passed through', () => {
  const negative = migrateSettings({ ...defaultSettings(), coreSlack: -3 });
  assert.equal(negative.settings.coreSlack, 0);
  assert.equal(negative.migrated, true);
  const fractional = migrateSettings({ ...defaultSettings(), coreSlack: 2.5 });
  assert.equal(fractional.settings.coreSlack, 2);
});

t('migrateSettings: out-of-range weeklyTarget on v2 habit is clamped to 1-7', () => {
  const habits = defaultHabits().map((h) => (h.id === 'trained' ? { ...h, weeklyTarget: 99 } : h));
  const { settings } = migrateSettings({ ...defaultSettings(), habits });
  assert.equal(trainedHabit(settings.habits).weeklyTarget, 7);
  const zeroed = defaultHabits().map((h) => (h.id === 'trained' ? { ...h, weeklyTarget: 0 } : h));
  const clampedUp = migrateSettings({ ...defaultSettings(), habits: zeroed });
  assert.equal(trainedHabit(clampedUp.settings.habits).weeklyTarget, 1);
});

t('migrateSettings: v1 gymTargetPerWeek out of range is clamped on fold-in', () => {
  const { settings } = migrateSettings({ gymTargetPerWeek: 12 });
  assert.equal(trainedHabit(settings.habits).weeklyTarget, 7);
});

t('moveHabit: swaps adjacent habits of the same cadence', () => {
  const habits = freshHabits();
  const moved = moveHabit(habits, 'cookedAtHome', -1, '2026-07-14');
  const ids = moved.filter((h) => h.cadence === 'daily-core').map((h) => h.id);
  assert.deepEqual(ids, ['cookedAtHome', 'alcoholFree', 'sleptOnTime', 'workSprint', 'walked']);
});

t('moveHabit: no-op at the top or bottom of a cadence group', () => {
  const habits = freshHabits();
  assert.deepEqual(moveHabit(habits, 'alcoholFree', -1, '2026-07-14'), habits);
  assert.deepEqual(moveHabit(habits, 'walked', 1, '2026-07-14'), habits);
  // trained is the only weekly habit: nowhere to go in either direction.
  assert.deepEqual(moveHabit(habits, 'trained', 1, '2026-07-14'), habits);
});

t('moveHabit: skips over other cadences and archived same-cadence habits', () => {
  const habits = freshHabits().map((h) => (h.id === 'cookedAtHome' ? archiveHabit(h, '2026-07-01') : h));
  // sleptOnTime moving up must land above alcoholFree, hopping the archived
  // cookedAtHome (and never pairing with the weekly `trained` above it).
  const moved = moveHabit(habits, 'sleptOnTime', -1, '2026-07-14');
  const ids = moved.map((h) => h.id);
  assert.deepEqual(ids.slice(0, 4), ['trained', 'sleptOnTime', 'cookedAtHome', 'alcoholFree']);
});

t('moveHabit: unknown id -> same array; input never mutated', () => {
  const habits = freshHabits();
  const snapshot = JSON.parse(JSON.stringify(habits));
  assert.equal(moveHabit(habits, 'nope', 1, '2026-07-14'), habits);
  moveHabit(habits, 'cookedAtHome', -1, '2026-07-14');
  assert.deepEqual(habits, snapshot);
});

t('weeklyDoneOn: true when any active weekly-quota habit was done that day', () => {
  const habits = [
    ...freshHabits(),
    { id: 'meditated', label: 'Meditated', cadence: 'weekly-quota', weeklyTarget: 5, active: [{ from: null, to: null }] },
  ];
  assert.equal(weeklyDoneOn(e('2026-07-14', { trained: true }), habits, '2026-07-14'), true);
  assert.equal(weeklyDoneOn(e('2026-07-14', { meditated: true }), habits, '2026-07-14'), true);
  assert.equal(weeklyDoneOn(hitEntry('2026-07-14', { bonusReading: true }), habits, '2026-07-14'), false);
  assert.equal(weeklyDoneOn(undefined, habits, '2026-07-14'), false);
});

t('weeklyDoneOn: a weekly habit archived before that day no longer marks it', () => {
  const habits = freshHabits().map((h) => (h.id === 'trained' ? archiveHabit(h, '2026-07-10') : h));
  assert.equal(weeklyDoneOn(e('2026-07-09', { trained: true }), habits, '2026-07-09'), true);
  assert.equal(weeklyDoneOn(e('2026-07-10', { trained: true }), habits, '2026-07-10'), false);
});

// --- stage 4: weekStartsOn -----------------------------------------------
// 2026-07-06 is a Monday, 2026-07-11 a Saturday, 2026-07-12 a Sunday.

t('weekStart: sunday start — Sunday is its own week start, Mon..Sat map back to it', () => {
  assert.equal(weekStart('2026-07-12', 'sunday'), '2026-07-12');
  assert.equal(weekStart('2026-07-06', 'sunday'), '2026-07-05'); // Mon -> previous Sun
  assert.equal(weekStart('2026-07-11', 'sunday'), '2026-07-05'); // Sat -> previous Sun
});

t('weekStart: saturday start — Saturday is its own week start, Sun..Fri map back to it', () => {
  assert.equal(weekStart('2026-07-11', 'saturday'), '2026-07-11');
  assert.equal(weekStart('2026-07-12', 'saturday'), '2026-07-11'); // Sun -> Sat before it
  assert.equal(weekStart('2026-07-10', 'saturday'), '2026-07-04'); // Fri -> previous Sat
});

t('weekStart: year and month boundaries for all three starts', () => {
  // 2026-01-01 is a Thursday.
  assert.equal(weekStart('2026-01-01', 'monday'), '2025-12-29');
  assert.equal(weekStart('2026-01-01', 'sunday'), '2025-12-28');
  assert.equal(weekStart('2026-01-01', 'saturday'), '2025-12-27');
  // 2026-08-01 is a Saturday.
  assert.equal(weekStart('2026-08-01', 'monday'), '2026-07-27');
  assert.equal(weekStart('2026-08-01', 'sunday'), '2026-07-26');
  assert.equal(weekStart('2026-08-01', 'saturday'), '2026-08-01');
});

t('weekStart: omitted or unknown weekStartsOn falls back to monday', () => {
  assert.equal(weekStart('2026-07-12'), '2026-07-06');
  assert.equal(weekStart('2026-07-12', 'banana'), '2026-07-06');
});

t('weeklyQuotaStreak: the week boundary shift changes bucketing (Sunday case)', () => {
  const entries = {
    '2026-07-12': e('2026-07-12', { trained: true }), // Sunday
    '2026-07-06': e('2026-07-06', { trained: true }), // Monday
    '2026-07-07': e('2026-07-07', { trained: true }), // Tuesday
    '2026-07-13': e('2026-07-13', { trained: true }), // next Monday
  };
  const habit = trainedHabit(freshHabits());
  // Monday weeks: 07-06..07-12 holds Mon+Tue+Sun = 3/3 -> streak 1.
  assert.equal(weeklyQuotaStreak(entries, habit, '2026-07-12', 'monday'), 1);
  // Sunday weeks: current week 07-12..07-18 has Sun+Mon = 2/3 in progress (no
  // credit yet), and the completed week 07-05..07-11 had only 2/3 -> streak 0.
  assert.equal(weeklyQuotaStreak(entries, habit, '2026-07-12', 'sunday'), 0);
});

// --- editor redesign: has-history gate and remove -------------------------

t('habitHasHistory: true only when some entry marks the habit done', () => {
  const entries = {
    '2026-07-13': e('2026-07-13', { walked: true }),
    '2026-07-14': e('2026-07-14'),
  };
  assert.equal(habitHasHistory(entries, 'walked'), true);
  assert.equal(habitHasHistory(entries, 'cookedAtHome'), false);
});

t('habitHasHistory: false stamps from createEmptyEntry are NOT history', () => {
  // A brand-new habit gets stamped false onto today's entry the moment any
  // habit is toggled — that alone must not block Remove.
  const entries = {
    '2026-07-15': e('2026-07-15', { walked: true, newHabit: false }),
  };
  assert.equal(habitHasHistory(entries, 'newHabit'), false);
});

t('habitHasHistory: empty entries or unknown id -> false; done on an off-day counts', () => {
  assert.equal(habitHasHistory({}, 'walked'), false);
  assert.equal(habitHasHistory({ '2026-07-14': e('2026-07-14') }, 'neverExisted'), false);
  const offDay = { '2026-07-14': e('2026-07-14', { walked: true, offDay: true }) };
  assert.equal(habitHasHistory(offDay, 'walked'), true);
});

t('removeHabit: deletes exactly that habit from config; input not mutated', () => {
  const habits = freshHabits();
  const snapshot = JSON.parse(JSON.stringify(habits));
  const removed = removeHabit(habits, 'bonusReading');
  assert.equal(removed.length, habits.length - 1);
  assert.ok(!removed.some((h) => h.id === 'bonusReading'));
  assert.deepEqual(removeHabit(habits, 'nope').map((h) => h.id), habits.map((h) => h.id));
  assert.deepEqual(habits, snapshot);
});

t('historyWeeks: week columns re-bucket under a different start day', () => {
  const today = '2026-07-12'; // Sunday
  const sundayWeeks = historyWeeks({}, freshHabits(), today, 5, 'sunday');
  assert.equal(sundayWeeks[4].start, '2026-07-12'); // today opens the current week
  assert.deepEqual(sundayWeeks[4].days.map((d) => d.future),
    [false, true, true, true, true, true, true]);
  const saturdayWeeks = historyWeeks({}, freshHabits(), today, 5, 'saturday');
  assert.equal(saturdayWeeks[4].start, '2026-07-11');
  for (const w of [...sundayWeeks, ...saturdayWeeks]) {
    assert.equal(w.days.length, 7);
    assert.equal(w.days[0].date, w.start);
  }
});

// --- settings v2 defaults ----------------------------------------------

t('DEFAULT_SETTINGS: v2 shape with sane defaults; holdToComplete off', () => {
  assert.equal(DEFAULT_SETTINGS.schemaVersion, 2);
  assert.equal(DEFAULT_SETTINGS.coreSlack, 1);
  assert.equal(DEFAULT_SETTINGS.habits.length, 8);
  assert.equal(DEFAULT_SETTINGS.holdToComplete, false);
  assert.equal(DEFAULT_SETTINGS.github.enabled, false);
});

// --- js/importer.js: parseImport -------------------------------------------

t('parseImport: round-trips the shape produced by exportString', () => {
  const entries = {
    '2026-07-01': hitEntry('2026-07-01'),
    '2026-07-02': e('2026-07-02', { offDay: true }),
  };
  const json = exportString(entries, DEFAULT_SETTINGS);
  const result = parseImport(json);
  assert.equal(result.error, undefined);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.entries, entries);
});

t('parseImport: not JSON -> calm error', () => {
  const result = parseImport('not json at all {');
  assert.ok(result.error);
  assert.equal(result.entries, undefined);
});

t('parseImport: missing entries field -> error', () => {
  const result = parseImport(JSON.stringify({ version: 1, settings: {} }));
  assert.ok(result.error);
});

t('parseImport: entries is not an object -> error', () => {
  const result = parseImport(JSON.stringify({ entries: 'nope' }));
  assert.ok(result.error);
});

t('parseImport: non-object top level input -> error', () => {
  assert.ok(parseImport(JSON.stringify([1, 2, 3])).error);
  assert.ok(parseImport(JSON.stringify('a string')).error);
  assert.ok(parseImport(JSON.stringify(null)).error);
});

t('parseImport: empty entries -> error', () => {
  const result = parseImport(JSON.stringify({ entries: {} }));
  assert.ok(result.error);
});

t('parseImport: bad date keys and non-object values are skipped and counted', () => {
  const payload = {
    entries: {
      '2026-07-01': hitEntry('2026-07-01'),
      'not-a-date': hitEntry('2026-07-02'),
      '2026-13-40': hitEntry('2026-07-03'), // wrong shape but matches the regex is not required here
      '2026-07-04': 'nope',
    },
  };
  const result = parseImport(JSON.stringify(payload));
  assert.equal(result.error, undefined);
  assert.deepEqual(Object.keys(result.entries).sort(), ['2026-07-01', '2026-13-40']);
  assert.equal(result.skipped, 2);
});

t('parseImport: settings field in the payload is ignored entirely', () => {
  const payload = {
    entries: { '2026-07-01': hitEntry('2026-07-01') },
    settings: { github: { token: 'fake-test-token-value', enabled: true } },
  };
  const result = parseImport(JSON.stringify(payload));
  assert.equal(result.settings, undefined);
  assert.equal(JSON.stringify(result).includes('fake-test-token-value'), false);
});

// --- js/importer.js: countUpdated -------------------------------------------

t('countUpdated: new days and changed days count; unchanged days do not', () => {
  const before = {
    '2026-07-01': hitEntry('2026-07-01', { note: 'old' }),
    '2026-07-02': hitEntry('2026-07-02'),
  };
  const merged = {
    '2026-07-01': hitEntry('2026-07-01', { note: 'new' }), // changed
    '2026-07-02': hitEntry('2026-07-02'), // unchanged
    '2026-07-03': hitEntry('2026-07-03'), // new
  };
  const count = countUpdated(before, merged, ['2026-07-01', '2026-07-02', '2026-07-03']);
  assert.equal(count, 2);
});

// --- personal data guard -------------------------------------------------
// Production files must never contain personal paths, private org names,
// real tokens, or work-in-progress markers. Patterns are built by
// concatenation so this test file never matches its own scan.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

t('no personal data or markers in production files', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'index.html',
    'css/style.css',
    'sw.js',
    'manifest.webmanifest',
    'README.md',
    'tools/make-icons.mjs',
    ...readdirSync(join(root, 'js')).map((f) => join('js', f)),
  ];
  const forbidden = [
    '/Us' + 'ers/',
    'ALI' + '_Books',
    'ali' + '-books',
    'FRE' + 'OPP',
    'ghp' + '_',
    'github' + '_pat_',
    'TO' + 'DO',
    'FIX' + 'ME',
    'HA' + 'CK',
  ];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const term of forbidden) {
      assert.ok(!text.includes(term), `forbidden term "${term}" found in ${f}`);
    }
  }
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
