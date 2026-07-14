// Pure streak/stat derivation from entries. No side effects, no I/O.
// Config-driven: every function takes the `habits` array (+ `coreSlack`
// where a daily threshold is judged) instead of hardcoded habit lists.
import { addDays, weekStart } from './dates.js';
import { activeHabitsOn, activeCoresOn, effectiveThreshold } from './habits.js';

// Count of that day's active core habits hit on `entry` (raw, unjudged).
export function coreCount(entry, habits, dateIso) {
  if (!entry) return 0;
  let n = 0;
  for (const h of activeCoresOn(habits, dateIso)) {
    if (entry[h.id]) n++;
  }
  return n;
}

// A day "rests" (doesn't count, doesn't break) when it's an explicit off-day
// or when zero cores were active that day [R1] — the zero-active-cores rule.
function restsOn(entry, habits, dateIso) {
  if (entry.offDay) return true;
  return activeCoresOn(habits, dateIso).length === 0;
}

function coreHit(entry, habits, coreSlack, dateIso) {
  if (!entry || entry.offDay) return false;
  const threshold = effectiveThreshold(habits, coreSlack, dateIso);
  if (threshold === null) return false; // zero active cores: never a "hit", see restsOn
  return coreCount(entry, habits, dateIso) >= threshold;
}

function earliestDate(entries) {
  const keys = Object.keys(entries);
  if (keys.length === 0) return null;
  return keys.reduce((min, k) => (k < min ? k : min), keys[0]);
}

export function dailyStreak(entries, habits, coreSlack, todayIso) {
  const earliest = earliestDate(entries);
  let streak = 0;

  const todayEntry = entries[todayIso];
  if (todayEntry && coreHit(todayEntry, habits, coreSlack, todayIso)) {
    streak += 1;
  }
  // today missing, offDay, zero-active-cores, or below threshold: grace.

  if (earliest === null) {
    return streak;
  }

  let cursor = addDays(todayIso, -1);
  while (cursor >= earliest) {
    const e = entries[cursor];
    if (!e) {
      break; // gap breaks the chain
    }
    if (restsOn(e, habits, cursor)) {
      cursor = addDays(cursor, -1);
      continue; // off-day or zero active cores: skip, doesn't count, doesn't break
    }
    if (coreHit(e, habits, coreSlack, cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
      continue;
    }
    break; // logged but below threshold
  }

  return streak;
}

function habitFirstFrom(habit) {
  const first = habit.active[0];
  return first ? first.from : null;
}

function laterDate(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function habitCountInWeek(entries, habit, start) {
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (entries[d]?.[habit.id] === true) count++;
  }
  return count;
}

// Generalized per-habit weekly-quota streak (any habit with `weeklyTarget`).
// Bounded at the later of the earliest entry and the habit's first `from`
// date [R9] — otherwise a habit added mid-history would walk back into weeks
// before it existed and report a broken streak on day one.
export function weeklyQuotaStreak(entries, habit, todayIso, weekStartsOn = 'monday') {
  const target = habit.weeklyTarget;
  let streak = 0;

  let w = weekStart(todayIso, weekStartsOn);
  if (habitCountInWeek(entries, habit, w) >= target) {
    streak += 1;
  }

  const earliest = earliestDate(entries);
  if (earliest === null) {
    return streak;
  }

  const habitFrom = habitFirstFrom(habit);
  const lowerBound = habitFrom === null ? earliest : laterDate(earliest, habitFrom);
  const boundWeek = weekStart(lowerBound, weekStartsOn);

  w = addDays(w, -7);
  while (w >= boundWeek) {
    if (habitCountInWeek(entries, habit, w) >= target) {
      streak += 1;
      w = addDays(w, -7);
      continue;
    }
    break;
  }

  return streak;
}

export function weeklyQuotaProgress(entries, habit, todayIso, weekStartsOn = 'monday') {
  const start = weekStart(todayIso, weekStartsOn);
  const days = [];
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const hit = entries[d]?.[habit.id] === true;
    if (hit) count++;
    days.push(hit);
  }
  return { count, days };
}

export function cumulativeStats(entries, habits, coreSlack, todayIso) {
  const keys = Object.keys(entries);
  let totalLogged = 0;
  let totalCoreHit = 0;
  let totalTrained = 0;
  let offDayCount = 0;

  for (const k of keys) {
    const e = entries[k];
    totalLogged++;
    if (coreHit(e, habits, coreSlack, k)) totalCoreHit++;
    if (e.trained) totalTrained++;
    if (e.offDay) offDayCount++;
  }

  let last30Hit = 0;
  for (let i = 0; i < 30; i++) {
    const d = addDays(todayIso, -i);
    if (coreHit(entries[d], habits, coreSlack, d)) last30Hit++;
  }

  const earliest = earliestDate(entries);
  let bestStreak = 0;
  if (earliest !== null) {
    let run = 0;
    let cursor = earliest;
    while (cursor <= todayIso) {
      const e = entries[cursor];
      if (!e) {
        run = 0;
      } else if (restsOn(e, habits, cursor)) {
        // skip, run survives
      } else if (coreHit(e, habits, coreSlack, cursor)) {
        run += 1;
        if (run > bestStreak) bestStreak = run;
      } else {
        run = 0;
      }
      cursor = addDays(cursor, 1);
    }
  }

  return { totalLogged, totalCoreHit, totalTrained, bestStreak, offDayCount, last30Hit };
}

export function habitCounts(entries, habits) {
  const counts = {};
  for (const h of habits) counts[h.id] = 0;
  for (const k of Object.keys(entries)) {
    const e = entries[k];
    for (const h of habits) {
      if (e[h.id]) counts[h.id]++;
    }
  }
  return counts;
}

export function daySummary(entries, habits, dateIso) {
  const e = entries[dateIso];
  return {
    logged: !!e,
    count: e ? coreCount(e, habits, dateIso) : 0,
    coreTotal: activeCoresOn(habits, dateIso).length,
    trained: !!e?.trained,
    offDay: !!e?.offDay,
  };
}

// True when any weekly-quota habit active on that day was done — drives the
// history dot marker. With the default single `trained` habit this reduces
// exactly to the old entry.trained check.
export function weeklyDoneOn(entry, habits, dateIso) {
  if (!entry) return false;
  for (const h of activeHabitsOn(habits, dateIso)) {
    if (h.cadence === 'weekly-quota' && entry[h.id] === true) return true;
  }
  return false;
}

// Maps a day's core hits onto the 6-step history color ramp (i0..i5) as a
// ratio of that day's active core count, so intensity stays meaningful when
// the denominator isn't 5. For a 5-core config this is the identity (k -> k).
export function intensityLevel(count, coreTotal) {
  if (count <= 0 || coreTotal <= 0) return 0;
  return Math.min(5, Math.max(1, Math.round((5 * count) / coreTotal)));
}

export function historyWeeks(entries, habits, todayIso, weeks = 5, weekStartsOn = 'monday') {
  const currentStart = weekStart(todayIso, weekStartsOn);
  const result = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = addDays(currentStart, -7 * w);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const e = entries[d];
      days.push({
        date: d,
        logged: !!e,
        count: e ? coreCount(e, habits, d) : 0,
        coreTotal: activeCoresOn(habits, d).length,
        offDay: !!e?.offDay,
        weeklyDone: weeklyDoneOn(e, habits, d),
        future: d > todayIso,
      });
    }
    result.push({ start, days });
  }
  return result;
}

export function historyGrid(entries, habits, todayIso, n = 30) {
  const start = addDays(todayIso, -(n - 1));
  const grid = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(start, i);
    const e = entries[d];
    grid.push({
      date: d,
      logged: !!e,
      count: e ? coreCount(e, habits, d) : 0,
      coreTotal: activeCoresOn(habits, d).length,
      offDay: !!e?.offDay,
      weeklyDone: weeklyDoneOn(e, habits, d),
    });
  }
  return grid;
}
