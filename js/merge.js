// Pure entry-merge logic for sync. No I/O, no mutation of inputs.

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

export function mergeEntries(local, remote) {
  const merged = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const k of keys) {
    const l = local[k];
    const r = remote[k];
    if (l && r) {
      const lu = l.updatedAt;
      const ru = r.updatedAt;
      if (typeof ru === 'string' && typeof lu === 'string' && ru > lu) {
        merged[k] = r;
      } else {
        merged[k] = l;
      }
    } else if (l) {
      merged[k] = l;
    } else {
      merged[k] = r;
    }
  }

  let localChanged = false;
  let remoteChanged = false;

  for (const k of keys) {
    if (!deepEqual(merged[k], local[k])) localChanged = true;
    if (!deepEqual(merged[k], remote[k])) remoteChanged = true;
  }

  return { merged, localChanged, remoteChanged };
}
