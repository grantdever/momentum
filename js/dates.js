// Pure local-timezone date helpers. All date keys are "YYYY-MM-DD" strings,
// derived from local Date fields (never toISOString(), which is UTC).

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayISO(now = new Date()) {
  return formatLocal(now);
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return formatLocal(dt);
}

export const WEEK_STARTS = ['monday', 'sunday', 'saturday'];

// getDay() indices (0 = Sunday) for each supported week start.
const START_DAY_INDEX = { monday: 1, sunday: 0, saturday: 6 };

export function weekStart(iso, weekStartsOn = 'monday') {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const startDay = START_DAY_INDEX[weekStartsOn] ?? START_DAY_INDEX.monday;
  const offset = (dt.getDay() - startDay + 7) % 7; // days since the week started
  dt.setDate(dt.getDate() - offset);
  return formatLocal(dt);
}

// A date is editable from History when it falls within the rolling 7-day
// window ending today: today and the six prior days. Future dates and
// anything older are read-only. ISO "YYYY-MM-DD" strings compare lexically.
export function isEditableDate(dateIso, todayIso) {
  return dateIso <= todayIso && dateIso >= addDays(todayIso, -6);
}

// Day-of-month (no leading zero) from an ISO "YYYY-MM-DD" key. Pure slice —
// never constructs a Date, so it stays timezone-proof like the rest of this module.
export function dayOfMonth(iso) {
  return Number(iso.slice(8, 10));
}
