// Pure streak/stat derivation from entries. No side effects, no I/O.
import { addDays, weekStart } from './dates.js';

export const CORE_HABITS = ['alcoholFree', 'cookedAtHome', 'sleptOnTime', 'workSprint', 'walked'];

export const ALL_HABITS = [
  'trained',
  'alcoholFree',
  'cookedAtHome',
  'sleptOnTime',
  'workSprint',
  'walked',
  'bonusReading',
  'bonusNoGaming',
];

export function coreCount(entry) {
  if (!entry) return 0;
  let n = 0;
  for (const h of CORE_HABITS) {
    if (entry[h]) n++;
  }
  return n;
}

function hits(entry, threshold) {
  return !!entry && !entry.offDay && coreCount(entry) >= threshold;
}

function earliestDate(entries) {
  const keys = Object.keys(entries);
  if (keys.length === 0) return null;
  return keys.reduce((min, k) => (k < min ? k : min), keys[0]);
}

export function dailyStreak(entries, threshold, todayIso) {
  const earliest = earliestDate(entries);
  let streak = 0;

  const todayEntry = entries[todayIso];
  if (todayEntry && !todayEntry.offDay && hits(todayEntry, threshold)) {
    streak += 1;
  }
  // today missing, offDay, or below threshold: neither counts nor breaks (grace).

  if (earliest === null) {
    return streak;
  }

  let cursor = addDays(todayIso, -1);
  while (cursor >= earliest) {
    const e = entries[cursor];
    if (!e) {
      break; // gap breaks the chain
    }
    if (e.offDay) {
      cursor = addDays(cursor, -1);
      continue; // skip, doesn't count, doesn't break
    }
    if (hits(e, threshold)) {
      streak += 1;
      cursor = addDays(cursor, -1);
      continue;
    }
    break; // logged but below threshold
  }

  return streak;
}

function trainedInWeek(entries, monday) {
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    if (entries[d]?.trained === true) count++;
  }
  return count;
}

export function weeklyTrainingStreak(entries, target, todayIso) {
  const earliest = earliestDate(entries);
  let streak = 0;

  let w = weekStart(todayIso);
  if (trainedInWeek(entries, w) >= target) {
    streak += 1;
  }

  if (earliest === null) {
    return streak;
  }

  const earliestWeek = weekStart(earliest);
  w = addDays(w, -7);
  while (w >= earliestWeek) {
    if (trainedInWeek(entries, w) >= target) {
      streak += 1;
      w = addDays(w, -7);
      continue;
    }
    break;
  }

  return streak;
}

export function weekProgress(entries, todayIso) {
  const monday = weekStart(todayIso);
  const days = [];
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const trained = entries[d]?.trained === true;
    if (trained) count++;
    days.push(trained);
  }
  return { count, days };
}

export function cumulativeStats(entries, threshold, todayIso) {
  const keys = Object.keys(entries);
  let totalLogged = 0;
  let totalCoreHit = 0;
  let totalTrained = 0;
  let offDayCount = 0;

  for (const k of keys) {
    const e = entries[k];
    totalLogged++;
    if (!e.offDay && coreCount(e) >= threshold) totalCoreHit++;
    if (e.trained) totalTrained++;
    if (e.offDay) offDayCount++;
  }

  let last30Hit = 0;
  for (let i = 0; i < 30; i++) {
    if (hits(entries[addDays(todayIso, -i)], threshold)) last30Hit++;
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
      } else if (e.offDay) {
        // skip, run survives
      } else if (hits(e, threshold)) {
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

export function habitCounts(entries) {
  const counts = {};
  for (const h of ALL_HABITS) counts[h] = 0;
  for (const k of Object.keys(entries)) {
    const e = entries[k];
    for (const h of ALL_HABITS) {
      if (e[h]) counts[h]++;
    }
  }
  return counts;
}

export function daySummary(entries, dateIso) {
  const e = entries[dateIso];
  return {
    logged: !!e,
    count: e ? coreCount(e) : 0,
    trained: !!e?.trained,
    offDay: !!e?.offDay,
  };
}

export function historyWeeks(entries, threshold, todayIso, weeks = 5) {
  const currentMonday = weekStart(todayIso);
  const result = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const monday = addDays(currentMonday, -7 * w);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      const e = entries[d];
      days.push({
        date: d,
        logged: !!e,
        count: e ? coreCount(e) : 0,
        offDay: !!e?.offDay,
        trained: !!e?.trained,
        future: d > todayIso,
      });
    }
    result.push({ monday, days });
  }
  return result;
}

export function historyGrid(entries, threshold, todayIso, n = 30) {
  const start = addDays(todayIso, -(n - 1));
  const grid = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(start, i);
    const e = entries[d];
    grid.push({
      date: d,
      logged: !!e,
      count: e ? coreCount(e) : 0,
      offDay: !!e?.offDay,
      trained: !!e?.trained,
    });
  }
  return grid;
}
