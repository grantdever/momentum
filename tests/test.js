import assert from 'node:assert/strict';
import { todayISO, addDays, weekStart } from '../js/dates.js';
import {
  CORE_HABITS,
  ALL_HABITS,
  coreCount,
  dailyStreak,
  weeklyTrainingStreak,
  weekProgress,
  cumulativeStats,
  historyGrid,
  historyWeeks,
  habitCounts,
  daySummary,
} from '../js/streaks.js';
import { mergeEntries } from '../js/merge.js';

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

// ---------- streaks.js: coreCount ----------

t('coreCount excludes trained', () => {
  const entry = hitEntry('2026-07-12', { trained: true });
  assert.equal(coreCount(entry), 5);
  assert.ok(!CORE_HABITS.includes('trained'));
});

t('coreCount counts partial core hits', () => {
  const entry = e('2026-07-12', { alcoholFree: true, cookedAtHome: true, sleptOnTime: true });
  assert.equal(coreCount(entry), 3);
});

// ---------- streaks.js: dailyStreak ----------

t('dailyStreak: today unlogged + 3-day prior chain -> 3 (grace)', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 3);
});

t('dailyStreak: today logged & hit adds +1 to prior chain', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
    '2026-07-12': hitEntry('2026-07-12'),
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 4);
});

t('dailyStreak: today logged below threshold neither counts nor breaks', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
    '2026-07-12': e('2026-07-12', { alcoholFree: true, cookedAtHome: true }), // count=2
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 3);
});

t('dailyStreak: yesterday missing breaks chain (today grace still counts)', () => {
  const entries = {
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-12': hitEntry('2026-07-12'),
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 1);
});

t('dailyStreak: backfilling yesterday repairs the chain', () => {
  const entries = {
    '2026-07-10': hitEntry('2026-07-10'),
    '2026-07-11': hitEntry('2026-07-11'),
    '2026-07-12': hitEntry('2026-07-12'),
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 3);
});

t('dailyStreak: off-day bridge (hit, off, off, hit) spans to streak 2', () => {
  const entries = {
    '2026-07-08': hitEntry('2026-07-08'),
    '2026-07-09': e('2026-07-09', { offDay: true }),
    '2026-07-10': e('2026-07-10', { offDay: true }),
    '2026-07-11': hitEntry('2026-07-11'),
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 2);
});

t('dailyStreak: all off days -> 0', () => {
  const entries = {
    '2026-07-09': e('2026-07-09', { offDay: true }),
    '2026-07-10': e('2026-07-10', { offDay: true }),
    '2026-07-11': e('2026-07-11', { offDay: true }),
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 0);
});

t('dailyStreak: logged-but-missed past day breaks the chain', () => {
  const entries = {
    '2026-07-09': hitEntry('2026-07-09'),
    '2026-07-10': e('2026-07-10', { alcoholFree: true }), // count=1, below threshold
    '2026-07-11': hitEntry('2026-07-11'),
  };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 1);
});

t('dailyStreak: empty entries -> 0', () => {
  assert.equal(dailyStreak({}, 4, '2026-07-12'), 0);
});

t('dailyStreak: first-ever day logged & hit -> 1', () => {
  const entries = { '2026-07-12': hitEntry('2026-07-12') };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 1);
});

t('dailyStreak: threshold respected - exactly 4 of 5 passes at threshold 4', () => {
  const entry = e('2026-07-12', {
    alcoholFree: true,
    cookedAtHome: true,
    sleptOnTime: true,
    workSprint: true,
  });
  const entries = { '2026-07-11': entry, '2026-07-12': hitEntry('2026-07-12') };
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 2);
});

t('dailyStreak: threshold respected - 3 of 5 fails at threshold 4', () => {
  const entry = e('2026-07-11', {
    alcoholFree: true,
    cookedAtHome: true,
    sleptOnTime: true,
  });
  const entries = { '2026-07-11': entry, '2026-07-12': hitEntry('2026-07-12') };
  // today hits -> +1; yesterday (3/5) is below threshold -> breaks.
  assert.equal(dailyStreak(entries, 4, '2026-07-12'), 1);
});

// ---------- streaks.js: weeklyTrainingStreak ----------
// Weeks (Mon-Sun): W0 = 07-06..07-12, W-1 = 06-29..07-05, W-2 = 06-22..06-28, W-3 = 06-15..06-21

t('weeklyTrainingStreak: in-progress week under quota does not break prior streak', () => {
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
  assert.equal(weeklyTrainingStreak(entries, 3, '2026-07-08'), 2);
});

t('weeklyTrainingStreak: in-progress week at quota adds to streak', () => {
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
  assert.equal(weeklyTrainingStreak(entries, 3, '2026-07-08'), 3);
});

t('weeklyTrainingStreak: completed week below quota breaks', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }),
    '2026-07-07': e('2026-07-07', { trained: true }),
    '2026-07-08': e('2026-07-08', { trained: true }), // W0: 3/3
    '2026-06-29': e('2026-06-29', { trained: true }), // W-1: 1/3, completed -> breaks
  };
  assert.equal(weeklyTrainingStreak(entries, 3, '2026-07-08'), 1);
});

t('weeklyTrainingStreak: completed week with zero entries breaks', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }),
    '2026-07-07': e('2026-07-07', { trained: true }),
    '2026-07-08': e('2026-07-08', { trained: true }), // W0: 3/3
    '2026-06-15': e('2026-06-15', { trained: true }), // W-3 has an entry so earliest reaches back, W-1/W-2 empty
  };
  assert.equal(weeklyTrainingStreak(entries, 3, '2026-07-08'), 1);
});

t('weeklyTrainingStreak: trained on an off day still counts toward quota', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true, offDay: true }),
    '2026-07-07': e('2026-07-07', { trained: true, offDay: true }),
    '2026-07-08': e('2026-07-08', { trained: true, offDay: true }),
  };
  assert.equal(weeklyTrainingStreak(entries, 3, '2026-07-08'), 1);
});

t('weeklyTrainingStreak: week boundary - Sunday belongs to its own week, not the next Monday', () => {
  const entries = {
    '2026-07-12': e('2026-07-12', { trained: true }), // Sunday of W0
    '2026-07-06': e('2026-07-06', { trained: true }),
    '2026-07-07': e('2026-07-07', { trained: true }), // W0 total 3/3 incl. Sunday
    '2026-07-13': e('2026-07-13', { trained: true }), // next Monday, W+1, not counted for W0
  };
  assert.equal(weeklyTrainingStreak(entries, 3, '2026-07-12'), 1);
});

// ---------- streaks.js: weekProgress ----------

t('weekProgress: correct count and Mon..Sun boolean placement', () => {
  const entries = {
    '2026-07-06': e('2026-07-06', { trained: true }), // Mon
    '2026-07-09': e('2026-07-09', { trained: true }), // Thu
  };
  const result = weekProgress(entries, '2026-07-08'); // Wed, same week
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
  const stats = cumulativeStats(entries, 4, '2026-07-06');
  assert.equal(stats.bestStreak, 3);
});

t('cumulativeStats: totals correct', () => {
  const entries = {
    '2026-07-01': hitEntry('2026-07-01', { trained: true }),
    '2026-07-02': e('2026-07-02', { alcoholFree: true }), // below threshold
    '2026-07-03': e('2026-07-03', { offDay: true }),
  };
  const stats = cumulativeStats(entries, 4, '2026-07-03');
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
  const grid = historyGrid(entries, 4, '2026-07-12', 5);
  assert.equal(grid.length, 5);
  assert.equal(grid[0].date, '2026-07-08');
  assert.equal(grid[4].date, '2026-07-12');

  const missingDay = grid.find((d) => d.date === '2026-07-09');
  assert.equal(missingDay.logged, false);
  assert.equal(missingDay.count, 0);

  const hitDay = grid.find((d) => d.date === '2026-07-10');
  assert.equal(hitDay.logged, true);
  assert.equal(hitDay.count, 5);
  assert.equal(hitDay.trained, true);
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
  assert.equal(cumulativeStats(entries, 4, '2026-07-03').offDayCount, 2);
});

t('cumulativeStats: last30Hit counts threshold days in trailing 30-day window', () => {
  const entries = {
    '2026-07-12': hit('2026-07-12'),
    '2026-07-10': hit('2026-07-10'),
    '2026-07-05': e('2026-07-05'),                    // logged, below threshold
    '2026-07-03': hit('2026-07-03', { offDay: true }), // off day never hits
  };
  assert.equal(cumulativeStats(entries, 4, '2026-07-12').last30Hit, 2);
});

t('cumulativeStats: last30Hit window boundary — day 29 back counts, day 30 back does not', () => {
  const today = '2026-07-12';
  const entries = {
    [addDays(today, -29)]: hit(addDays(today, -29)),
    [addDays(today, -30)]: hit(addDays(today, -30)),
  };
  assert.equal(cumulativeStats(entries, 4, today).last30Hit, 1);
});

t('historyWeeks: 5 weeks, Monday-aligned, oldest first, ends with current week', () => {
  const today = '2026-07-12'; // a Sunday; week is Mon 2026-07-06 .. Sun 2026-07-12
  const wk = historyWeeks({}, 4, today);
  assert.equal(wk.length, 5);
  assert.equal(wk[4].monday, '2026-07-06');
  assert.equal(wk[0].monday, '2026-06-08');
  for (const w of wk) {
    assert.equal(w.days.length, 7);
    assert.equal(w.days[0].date, w.monday);
    assert.equal(weekStart(w.days[6].date), w.monday);
  }
});

t('historyWeeks: future flags only after today within current week', () => {
  const today = '2026-07-08'; // Wednesday; Thu-Sun of current week are future
  const wk = historyWeeks({}, 4, today);
  const current = wk[4];
  assert.deepEqual(current.days.map((d) => d.future),
    [false, false, false, true, true, true, true]);
  assert.ok(wk[3].days.every((d) => !d.future));
});

t('historyWeeks: cell flags for logged/off/trained and month-boundary dates', () => {
  const entries = {
    '2026-06-30': hit('2026-06-30', { trained: true }),
    '2026-07-01': e('2026-07-01', { offDay: true }),
  };
  const wk = historyWeeks(entries, 4, '2026-07-12');
  const flat = wk.flatMap((w) => w.days);
  const juneCell = flat.find((d) => d.date === '2026-06-30');
  const julyCell = flat.find((d) => d.date === '2026-07-01');
  assert.ok(juneCell.logged && juneCell.trained && juneCell.count === 4);
  assert.ok(julyCell.logged && julyCell.offDay && !julyCell.trained);
  const unlogged = flat.find((d) => d.date === '2026-07-02');
  assert.ok(!unlogged.logged && unlogged.count === 0);
});

// --- per-habit counts ------------------------------------------------------

t('habitCounts: empty entries -> all zeros for all 8 habits', () => {
  const counts = habitCounts({});
  assert.equal(Object.keys(counts).length, ALL_HABITS.length);
  for (const h of ALL_HABITS) assert.equal(counts[h], 0);
});

t('habitCounts: counts true fields across entries', () => {
  const entries = {
    '2026-07-01': e('2026-07-01', { walked: true, trained: true }),
    '2026-07-02': e('2026-07-02', { walked: true, bonusReading: true }),
    '2026-07-03': e('2026-07-03', { alcoholFree: true }),
  };
  const counts = habitCounts(entries);
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
  assert.equal(habitCounts(entries).walked, 1);
});

// --- morning ribbon summary ------------------------------------------------

t('daySummary: logged day reports count, trained, offDay', () => {
  const entries = {
    '2026-07-11': hitEntry('2026-07-11', { trained: true }),
  };
  const s = daySummary(entries, '2026-07-11');
  assert.deepEqual(s, { logged: true, count: 5, trained: true, offDay: false });
});

t('daySummary: off day reported as off with its count', () => {
  const entries = {
    '2026-07-11': e('2026-07-11', { offDay: true, walked: true }),
  };
  const s = daySummary(entries, '2026-07-11');
  assert.ok(s.logged && s.offDay);
  assert.equal(s.count, 1);
});

t('daySummary: unlogged day -> logged false, zeros', () => {
  const s = daySummary({}, '2026-07-11');
  assert.deepEqual(s, { logged: false, count: 0, trained: false, offDay: false });
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
