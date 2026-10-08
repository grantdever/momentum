// Writes a made-up Honest Streaks export for screenshots and demos.
// Every habit and note here is invented; never put real data in this file.
//
//   node tools/demo-data.mjs [endDate=YYYY-MM-DD] > demo-backup.json
//
// Then, on a fresh install (or a private window): Begin screen ->
// "Restore from a backup" -> pick demo-backup.json.
// Deterministic: the same endDate always produces the same file.

import { addDays, todayISO } from '../js/dates.js';
import { exportString } from '../js/store.js';
import { defaultSettings } from '../js/migrate.js';

const end = process.argv[2] || todayISO();
const DAYS = 120;
const start = addDays(end, -(DAYS - 1));

const habits = [
  { id: 'stretch', label: 'Stretch for five minutes', cadence: 'daily-core', active: [{ from: null, to: null }],
    plan: { anchor: 'pour my morning coffee', coping: "I'll pick it up the next day — no penalty." } },
  { id: 'journal', label: 'Write three lines', cadence: 'daily-core', active: [{ from: null, to: null }] },
  { id: 'practiceGuitar', label: 'Practice guitar', cadence: 'daily-core', active: [{ from: null, to: null }] },
  { id: 'tidyDesk', label: 'Clear the desk', cadence: 'daily-core', active: [{ from: null, to: null }] },
  { id: 'swimLaps', label: 'Swim laps', cadence: 'weekly-quota', weeklyTarget: 2, active: [{ from: null, to: null }] },
  { id: 'waterPlants', label: 'Water the plants', cadence: 'bonus', active: [{ from: null, to: null }] },
];

// Small deterministic PRNG so the grid looks lived-in but reproducible.
let seed = 20261006;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const entries = {};
for (let i = 0; i < DAYS; i++) {
  const date = addDays(start, i);
  // A realistic lapse: a quiet stretch about two-thirds of the way through.
  const lapse = i > 70 && i < 76;
  const p = lapse ? 0.15 : 0.82;
  const entry = { date, offDay: false, note: '', updatedAt: `${date}T21:00:00.000Z` };
  for (const h of habits) {
    const chance = h.cadence === 'weekly-quota' ? 0.3 : h.cadence === 'bonus' ? 0.25 : p;
    entry[h.id] = rand() < chance;
  }
  // The last two weeks clear the daily goal, so Today shows a live streak.
  if (i >= DAYS - 15) {
    for (const h of habits) if (h.cadence === 'daily-core') entry[h.id] = true;
    entry[habits[i % 4].id] = false;
  }
  if (i % 29 === 13) entry.offDay = true;
  // Leave today partly done so the Today screen has something to tap.
  if (date === end) {
    entry.journal = false;
    entry.tidyDesk = false;
  }
  entries[date] = entry;
}

const settings = { ...defaultSettings(), habits, coreSlack: 1 };
process.stdout.write(exportString(entries, settings, 'demo') + '\n');
