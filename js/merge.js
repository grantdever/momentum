// Deterministic 3-way / CRDT-style entry merge for sync. Pure: no I/O and
// never mutates its inputs.
//
// Data model: entries is a map of "YYYY-MM-DD" -> day object. A day object
// holds one boolean per habit id, plus `offDay` (boolean), `note` (string),
// `date` (the day key) and `updatedAt` (an ISO-8601 write stamp). There are
// no per-field stamps, so a two-way merge cannot know which side touched
// which field. The rules below are chosen so the failure mode is never a
// silently lost habit completion:
//
// - Habit booleans merge true-wins (a grow-only join): if either side logged
//   the habit as done, the merged day keeps it done. Completion writes are
//   the one thing this app must not drop, and true-wins is independent of
//   wall-clock order, so a device with a skewed clock cannot wipe another
//   device's check-ins. The known trade-off: without a base snapshot an
//   intentional uncheck (true -> false) on one device can be resurrected by
//   the other device's stale true. The three-way form below fixes that case
//   whenever the caller can supply the last-synced snapshot.
// - `note` and any other scalar field merge last-writer-wins by the day's
//   `updatedAt` stamp, with a deterministic content-based tie-break (lexical
//   max of the serialized values) so tied stamps converge identically on
//   every device.
// - `offDay` merges true-wins like a habit boolean: a rest day recorded on
//   either device survives, and keeping extra habit flags alongside it is
//   explicitly supported elsewhere (quota credit counts off-day work).
// - The merged day's `updatedAt` is the lexical max of the two stamps, so a
//   merge never moves the stamp backwards and re-merging is idempotent.
// - Day keys merge by union in sorted order, so output key order is stable
//   no matter which side listed a date first.
//
// mergeEntries(local, remote, base) accepts an optional third argument: the
// last-synced snapshot both sides diverged from. When provided (and only
// then) the merge is a true three-way per field:
//
// - a field changed on exactly one side wins, regardless of timestamps
//   (this is what lets a deliberate uncheck survive against a stale true);
// - a field changed on both sides, or on neither side but differing (a base
//   that predates both writes), falls back to the two-way conflict rule.
//
// Callers without a snapshot (offline-first launch, import) simply omit it
// and get the two-way CRDT-style merge. Both forms return
// { merged, localChanged, remoteChanged } with the same flag semantics the
// sync layer already relies on: localChanged means the merged map differs
// from the local input (adopt it locally), remoteChanged means it differs
// from the remote input (push it back).

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function clone(value) {
  if (typeof value !== 'object' || value === null) return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to the JSON path below.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

// -1 | 0 | 1 by ISO-8601 write stamp. Non-string stamps are unordered:
// they lose to a real stamp and tie with each other.
function compareStamps(a, b) {
  const aIsStr = typeof a === 'string';
  const bIsStr = typeof b === 'string';
  if (aIsStr && bIsStr) {
    if (a > b) return 1;
    if (a < b) return -1;
    return 0;
  }
  if (aIsStr) return 1;
  if (bIsStr) return -1;
  return 0;
}

function maxStamp(a, b) {
  return compareStamps(a, b) >= 0 ? a : b;
}

// Conflict fallback shared by the two-way and three-way paths. Booleans go
// true-wins; every other scalar goes last-writer-wins by day stamp with a
// deterministic content-based tie-break (equal stamps must converge
// identically on every device, so the value itself decides, not the side).
function stableSerialize(value) {
  try {
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) return JSON.stringify(value);
      const sorted = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return JSON.stringify(sorted);
    }
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function resolveFieldConflict(field, lv, rv, localStamp, remoteStamp) {
  if (typeof lv === 'boolean' && typeof rv === 'boolean') return lv || rv;
  if (lv === undefined) return clone(rv);
  if (rv === undefined) return clone(lv);
  const cmp = compareStamps(remoteStamp, localStamp);
  if (cmp > 0) return clone(rv);
  if (cmp < 0) return clone(lv);
  // Equal stamps: pick the lexical max of the serialized values so both
  // devices reach the same outcome however the arguments are ordered.
  // Identical serializations fall back to local (either choice converges).
  const ls = stableSerialize(lv);
  const rs = stableSerialize(rv);
  if (rs === ls) return clone(lv);
  return rs > ls ? clone(rv) : clone(lv);
}

// Merge one day object. All three arguments are left untouched; the result
// is a fresh object. A missing day (null/undefined) merges as "no opinion".
export function mergeDayEntry(local, remote, base) {
  if (!isPlainObject(local)) return clone(remote);
  if (!isPlainObject(remote)) return clone(local);
  if (deepEqual(local, remote)) return clone(local);

  const hasBase = isPlainObject(base);
  const out = {};
  const fields = new Set([...Object.keys(local), ...Object.keys(remote)]);
  fields.delete('updatedAt');

  for (const field of fields) {
    const lv = local[field];
    const rv = remote[field];
    if (deepEqual(lv, rv)) {
      out[field] = clone(lv);
      continue;
    }
    if (hasBase) {
      const bv = base[field];
      const localChanged = !deepEqual(lv, bv);
      const remoteChanged = !deepEqual(rv, bv);
      if (localChanged && !remoteChanged) {
        out[field] = clone(lv);
        continue;
      }
      if (remoteChanged && !localChanged) {
        out[field] = clone(rv);
        continue;
      }
      // Changed on both sides (or base predates both writes): fall through
      // to the deterministic conflict rule.
    } else if (lv === undefined) {
      out[field] = clone(rv);
      continue;
    } else if (rv === undefined) {
      out[field] = clone(lv);
      continue;
    }
    out[field] = resolveFieldConflict(field, lv, rv, local.updatedAt, remote.updatedAt);
  }

  if (local.updatedAt !== undefined || remote.updatedAt !== undefined) {
    out.updatedAt = maxStamp(local.updatedAt, remote.updatedAt);
  }
  return out;
}

export function mergeEntries(local, remote, base) {
  const safeLocal = isPlainObject(local) ? local : {};
  const safeRemote = isPlainObject(remote) ? remote : {};
  const safeBase = isPlainObject(base) ? base : null;
  const merged = {};
  const keys = [...new Set([...Object.keys(safeLocal), ...Object.keys(safeRemote)])]
    .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
    .sort();

  for (const k of keys) {
    const l = safeLocal[k];
    const r = safeRemote[k];
    if (isPlainObject(l) && isPlainObject(r)) {
      const b = safeBase ? safeBase[k] : undefined;
      merged[k] = mergeDayEntry(l, r, isPlainObject(b) ? b : undefined);
    } else if (isPlainObject(l)) {
      merged[k] = clone(l);
    } else if (isPlainObject(r)) {
      merged[k] = clone(r);
    } else if (l !== undefined) {
      merged[k] = clone(l);
    } else {
      merged[k] = clone(r);
    }
  }

  let localChanged = false;
  let remoteChanged = false;

  for (const k of keys) {
    if (!deepEqual(merged[k], safeLocal[k])) localChanged = true;
    if (!deepEqual(merged[k], safeRemote[k])) remoteChanged = true;
    if (localChanged && remoteChanged) break;
  }

  return { merged, localChanged, remoteChanged };
}
