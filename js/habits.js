// Pure habit-config helpers: defaults, effective-dating, id generation.
// No side effects, no I/O.

// Entry keys that a habit id must never collide with (see schema-design.md D1).
// `frozen` is reserved for a future scheduled-days cadence, cost-free today.
export const RESERVED_KEYS = ['date', 'offDay', 'note', 'updatedAt', 'frozen'];

// The 5 daily-core habit ids from v1, in their historic order. Used only by
// the coreThreshold -> coreSlack migration formula (see migrate.js).
export const LEGACY_CORE_HABITS = ['alcoholFree', 'cookedAtHome', 'sleptOnTime', 'workSprint', 'walked'];

function openInterval() {
  return [{ from: null, to: null }];
}

// The 8 legacy habits, each open since the beginning. This is now the single
// source of truth for ids/labels/cadences (labels used to live in render.js's
// HABIT_DISPLAY). Returns a fresh deep copy every call so callers can safely
// mutate the result.
export function defaultHabits() {
  return [
    { id: 'trained', label: 'Trained', cadence: 'weekly-quota', weeklyTarget: 3, active: openInterval() },
    { id: 'alcoholFree', label: 'Alcohol-free', cadence: 'daily-core', active: openInterval() },
    { id: 'cookedAtHome', label: 'Cooked', cadence: 'daily-core', active: openInterval() },
    { id: 'sleptOnTime', label: 'Asleep on time', cadence: 'daily-core', active: openInterval() },
    { id: 'workSprint', label: 'One deep block', cadence: 'daily-core', active: openInterval() },
    { id: 'walked', label: 'Walked', cadence: 'daily-core', active: openInterval() },
    { id: 'bonusReading', label: 'Read', cadence: 'bonus', active: openInterval() },
    { id: 'bonusNoGaming', label: 'No gaming', cadence: 'bonus', active: openInterval() },
  ];
}

function isActiveOn(habit, dateIso) {
  return habit.active.some(({ from, to }) => (from === null || dateIso >= from) && (to === null || dateIso < to));
}

export function activeHabitsOn(habits, dateIso) {
  return habits.filter((h) => isActiveOn(h, dateIso));
}

export function activeCoresOn(habits, dateIso) {
  return habits.filter((h) => h.cadence === 'daily-core' && isActiveOn(h, dateIso));
}

// Effective daily threshold for a given day: max(1, activeCoreCount - slack),
// or null if zero cores are active that day [R1] — callers must treat null
// as "not evaluated" (off-day semantics), never as an unreachable threshold.
export function effectiveThreshold(habits, coreSlack, dateIso) {
  const activeCores = activeCoresOn(habits, dateIso);
  if (activeCores.length === 0) return null;
  return Math.max(1, activeCores.length - coreSlack);
}

// Archive closes the currently-open interval at dateIso (to is exclusive).
// No-op if the habit is already archived.
export function archiveHabit(habit, dateIso) {
  const last = habit.active[habit.active.length - 1];
  if (!last || last.to !== null) return habit;
  const active = habit.active.slice(0, -1).concat([{ from: last.from, to: dateIso }]);
  return { ...habit, active };
}

// Unarchive appends a fresh open interval starting at dateIso. The archived
// gap is never retroactively reopened.
export function unarchiveHabit(habit, dateIso) {
  return { ...habit, active: [...habit.active, { from: dateIso, to: null }] };
}

// Delete a habit from the config. Callers must only offer this while the
// habit has no logged history (see habitHasHistory in streaks.js) — with
// history, archive is the only path. Config-only: entries are never touched.
export function removeHabit(habits, id) {
  return habits.filter((h) => h.id !== id);
}

// Validate a habit's optional implementation-intention plan. Returns
// { anchor, coping? } with trimmed, length-capped strings, or null when the
// anchor is missing or blank — a plan without a cue is just a wish. A bad
// coping value drops only the coping line, never the whole plan.
export const PLAN_MAX_LEN = 120;

function cleanPlanText(value) {
  // trim -> cap -> trim again so the result is stable under re-validation
  // (a cap that lands on a space must not reopen the trim on the next pass).
  return value.trim().slice(0, PLAN_MAX_LEN).trim();
}

export function validatePlan(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (typeof raw.anchor !== 'string') return null;
  const anchor = cleanPlanText(raw.anchor);
  if (!anchor) return null;
  const plan = { anchor };
  if (typeof raw.coping === 'string') {
    const coping = cleanPlanText(raw.coping);
    if (coping) plan.coping = coping;
  }
  return plan;
}

// Interval rule for wizard-created habits. On a fresh install there is no
// history to protect, and an open interval avoids the weekly-quota lower
// bound edge on day one — so every habit made during a fresh-install wizard
// session opens unbounded. On existing data (the #setup route), activation
// starts today so history stays untouched, same as the create screen.
export function wizardInterval(freshSession, todayIso) {
  return freshSession ? [{ from: null, to: null }] : [{ from: todayIso, to: null }];
}

// Build a new habit object: id minted against the full stored array, weekly
// target clamped (weekly-quota only), plan validated and attached only when
// well-formed. The single shape producer for both the create screen and the
// setup wizard.
export function createHabit({ label, cadence, weeklyTarget, plan, active, habits }) {
  const habit = { id: generateHabitId(label, habits), label, cadence, active };
  if (cadence === 'weekly-quota') {
    habit.weeklyTarget = clampWeeklyTarget(weeklyTarget) ?? 3;
  }
  const validPlan = validatePlan(plan);
  if (validPlan) habit.plan = validPlan;
  return habit;
}

// Editor/validation clamps. Both return null for non-numeric garbage so
// callers can fall back to their own default; finite values are treated as
// intent and clamped into range.
export function clampSlack(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

export function clampWeeklyTarget(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(7, Math.max(1, Math.trunc(value)));
}

// Swap a habit with its nearest neighbor of the same cadence that is active
// on dateIso (delta -1 = up, +1 = down). Archived habits and other cadences
// are skipped over, so reordering stays within the displayed group. Returns
// a new array; the input is never mutated. No-op at group boundaries.
export function moveHabit(habits, id, delta, dateIso) {
  const idx = habits.findIndex((h) => h.id === id);
  if (idx === -1) return habits;
  const cadence = habits[idx].cadence;
  let j = idx + delta;
  while (j >= 0 && j < habits.length) {
    if (habits[j].cadence === cadence && isActiveOn(habits[j], dateIso)) break;
    j += delta;
  }
  if (j < 0 || j >= habits.length) return habits;
  const out = habits.slice();
  [out[idx], out[j]] = [out[j], out[idx]];
  return out;
}

function slugify(label) {
  const words = String(label)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'habit';
  return words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('');
}

// Change a habit's type by archiving it and creating a successor: the old
// habit's open interval closes at dateIso (its history stays under its own
// id forever), and a fresh habit with the same label but a NEW id starts
// from dateIso. The id is never reused — that separation is the point: the
// two cadences' histories must not blend. The successor is inserted directly
// after the old habit so the pair stays adjacent in config order. Entries
// are never touched. No-op if the id is unknown.
export function changeHabitType(habits, id, newCadence, dateIso, weeklyTarget) {
  const idx = habits.findIndex((h) => h.id === id);
  if (idx === -1) return habits;
  const old = habits[idx];
  const successor = {
    id: generateHabitId(old.label, habits),
    label: old.label,
    cadence: newCadence,
    active: [{ from: dateIso, to: null }],
  };
  if (newCadence === 'weekly-quota') {
    successor.weeklyTarget = clampWeeklyTarget(weeklyTarget) ?? 3;
  }
  const out = habits.slice();
  out[idx] = archiveHabit(old, dateIso);
  out.splice(idx + 1, 0, successor);
  return out;
}

// camelCase slug of the label, deduped with a numeric suffix against the
// reserved-key blocklist and the full historical id set (active + archived
// habits alike, per [R4][R5]) — `habits` should be the complete stored array.
export function generateHabitId(label, habits) {
  const taken = new Set([...RESERVED_KEYS, ...habits.map((h) => h.id)]);
  const base = slugify(label);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}
