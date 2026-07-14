// Pure JSON-import validation for restoring a Momentum export. No DOM, no
// storage, no fetch. Entries only — the export's settings field (which can
// carry a GitHub token) is never read here, so an import can never clobber
// sync configuration.

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseImport(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { error: 'That file is not valid JSON.' };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) {
    return { error: "That file doesn't look like a Momentum export." };
  }

  const entries = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (DATE_KEY.test(key) && isPlainObject(value)) {
      entries[key] = value;
    } else {
      skipped++;
    }
  }

  if (Object.keys(entries).length === 0) {
    return { error: 'No valid days found in that file.' };
  }

  return { entries, skipped };
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
