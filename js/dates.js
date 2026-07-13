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

export function weekStart(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const offset = (dt.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  dt.setDate(dt.getDate() - offset);
  return formatLocal(dt);
}
