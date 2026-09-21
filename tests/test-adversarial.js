// Adversarial red-team suite for the habit sync merge + persistence modules.
// Attempts to break merge resolution and storage handling. Run with:
//   node tests/test-adversarial.js
// Verdict policy: tests assert the DESIRED safe behavior. A failure is
// evidence of a real robustness gap, not a bad test.

import assert from 'node:assert/strict';
import { mergeEntries, mergeDayEntry } from '../js/merge.js';
import {
  checkPersistence,
  ensurePersistence,
  __resetPersistenceMemo,
} from '../js/persistence.js';

let pass = 0;
let fail = 0;
const failures = [];
const pending = [];

function t(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(
        result.then(
          () => {
            pass++;
            console.log(`ok: ${name}`);
          },
          (err) => {
            fail++;
            failures.push(name);
            console.error(`FAIL: ${name}`);
            console.error(err && err.message ? err.message : err);
          }
        )
      );
    } else {
      pass++;
      console.log(`ok: ${name}`);
    }
  } catch (err) {
    fail++;
    failures.push(name);
    console.error(`FAIL: ${name}`);
    console.error(err && err.message ? err.message : err);
  }
}

function day(date, overrides = {}) {
  return { date, note: '', offDay: false, updatedAt: '2026-07-01T00:00:00.000Z', ...overrides };
}

// Permutations of three elements (for merge-order convergence checks).
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) {
      out.push([arr[i], ...rest]);
    }
  }
  return out;
}

// ---------- A. Concurrent 3-device edits, out-of-order arrival ----------

t('A1: 3 devices x different habits converge to all-true in every merge order', () => {
  const d1 = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T10:00:00.000Z' }) };
  const d2 = { '2026-07-01': day('2026-07-01', { drinkWater: true, updatedAt: '2026-07-01T11:00:00.000Z' }) };
  const d3 = { '2026-07-01': day('2026-07-01', { readBooks: true, updatedAt: '2026-07-01T12:00:00.000Z' }) };
  const seen = [];
  for (const [a, b, c] of permutations([d1, d2, d3])) {
    const ab = mergeEntries(a, b).merged;
    const abc = mergeEntries(ab, c).merged;
    const flags = ['moveBody', 'drinkWater', 'readBooks'].map((f) => abc['2026-07-01'][f]);
    assert.deepEqual(flags, [true, true, true], `order matters: ${JSON.stringify(flags)}`);
    seen.push(abc);
  }
  // Boolean union is order-independent; every order must yield an equal map.
  // (Day-object key insertion order may vary; only day-key order is promised
  // stable, so compare by value, not by serialization.)
  for (const s of seen) assert.deepEqual(s, seen[0], 'merge order changed the merged value');
});

t('A2: out-of-order arrival — stale device syncing last cannot wipe newer completions', () => {
  // Device B logs 07-02 later; device A logged 07-01 earlier but its push
  // arrives LAST (stale). Both completions must survive the late merge.
  const staleA = {
    '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T08:00:00.000Z' }),
  };
  const freshB = {
    '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T08:00:00.000Z' }),
    '2026-07-02': day('2026-07-02', { drinkWater: true, updatedAt: '2026-07-03T08:00:00.000Z' }),
  };
  const { merged } = mergeEntries(freshB, staleA); // stale arrives second
  assert.equal(merged['2026-07-01'].moveBody, true);
  assert.equal(merged['2026-07-02'].drinkWater, true);
  assert.deepEqual(Object.keys(merged).sort(), ['2026-07-01', '2026-07-02']);
  // And the reverse arrival order converges identically.
  const flipped = mergeEntries(staleA, freshB).merged;
  assert.deepEqual(flipped, merged);
});

t('A3: 3-way with base — one deliberate uncheck survives two stale trues', () => {
  const base = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T08:00:00.000Z' }) };
  const unchecker = { '2026-07-01': day('2026-07-01', { moveBody: false, updatedAt: '2026-07-01T09:00:00.000Z' }) };
  const staleTrue = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T12:00:00.000Z' }) };
  const { merged } = mergeEntries(unchecker, staleTrue, base);
  assert.equal(merged['2026-07-01'].moveBody, false);
});

t('A4: re-merge is a fixed point (output stable; merged-vs-merged flags quiet)', () => {
  const local = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T12:00:00.000Z' }) };
  const remote = { '2026-07-01': day('2026-07-01', { drinkWater: true, updatedAt: '2026-07-01T10:00:00.000Z' }) };
  const first = mergeEntries(local, remote);
  // Union merge is a fixed point: merging the result with either input
  // reproduces the same merged value (the inputs themselves remain subsets,
  // so their changed-flags legitimately stay set — they still need the union).
  assert.deepEqual(mergeEntries(first.merged, remote).merged, first.merged);
  assert.deepEqual(mergeEntries(local, first.merged).merged, first.merged);
  // Merging the result with itself is fully quiet.
  const self = mergeEntries(first.merged, first.merged);
  assert.deepEqual(self.merged, first.merged);
  assert.equal(self.localChanged, false);
  assert.equal(self.remoteChanged, false);
});

// ---------- B. Clock skew / drift ----------

t('B1: past-clock completion survives future-clock note-only edit', () => {
  const pastDevice = {
    '2026-07-01': day('2026-07-01', { moveBody: true, note: 'morning walk', updatedAt: '2026-06-24T08:00:00.000Z' }),
  };
  const futureDevice = {
    '2026-07-01': day('2026-07-01', { moveBody: false, note: 'evening note', updatedAt: '2026-07-08T08:00:00.000Z' }),
  };
  const { merged } = mergeEntries(pastDevice, futureDevice);
  assert.equal(merged['2026-07-01'].moveBody, true);
  assert.equal(merged['2026-07-01'].note, 'evening note');
});

t('B2: completions on both skewed clocks union regardless of stamp order', () => {
  const past = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-06-20T00:00:00.000Z' }) };
  const future = { '2026-07-01': day('2026-07-01', { drinkWater: true, updatedAt: '2026-07-20T00:00:00.000Z' }) };
  assert.equal(mergeEntries(past, future).merged['2026-07-01'].moveBody, true);
  assert.equal(mergeEntries(past, future).merged['2026-07-01'].drinkWater, true);
  assert.equal(mergeEntries(future, past).merged['2026-07-01'].moveBody, true);
  assert.equal(mergeEntries(future, past).merged['2026-07-01'].drinkWater, true);
});

t('B3: merged stamp is the max and never moves backwards under skew', () => {
  const a = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-06-20T00:00:00.000Z' }) };
  const b = { '2026-07-01': day('2026-07-01', { drinkWater: true, updatedAt: '2026-07-20T00:00:00.000Z' }) };
  const { merged } = mergeEntries(a, b);
  assert.equal(merged['2026-07-01'].updatedAt, '2026-07-20T00:00:00.000Z');
  const remerged = mergeEntries(merged, a).merged;
  assert.equal(remerged['2026-07-01'].updatedAt, '2026-07-20T00:00:00.000Z');
});

// ---------- C. Timezone day-boundary edges ----------

t('C1: same instant logged under different local day keys unions without loss', () => {
  // 23:30 UTC on 07-01 is still 07-01 in New York but already 07-02 in Berlin.
  const newYork = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T23:30:00.000Z' }) };
  const berlin = { '2026-07-02': day('2026-07-02', { drinkWater: true, updatedAt: '2026-07-01T23:35:00.000Z' }) };
  const { merged } = mergeEntries(newYork, berlin);
  assert.deepEqual(Object.keys(merged).sort(), ['2026-07-01', '2026-07-02']);
  assert.equal(merged['2026-07-01'].moveBody, true);
  assert.equal(merged['2026-07-02'].drinkWater, true);
});

t('C2: date-field/key mismatch and odd key order stay deterministic', () => {
  const local = {
    '2026-07-02': day('2026-07-01', { moveBody: true }), // stale date field, key wins
    '2026-07-01': day('2026-07-01', { drinkWater: true }),
  };
  const remote = { '2026-06-30': day('2026-06-30', { moveBody: true }) };
  const { merged } = mergeEntries(local, remote);
  assert.deepEqual(Object.keys(merged), ['2026-06-30', '2026-07-01', '2026-07-02']);
  assert.equal(merged['2026-07-02'].moveBody, true);
  assert.deepEqual(Object.keys(mergeEntries(remote, local).merged), Object.keys(merged));
});

// ---------- D. StorageManager quota errors + partial write failures ----------

function quotaError() {
  const e = new Error('QuotaExceededError');
  e.name = 'QuotaExceededError';
  return e;
}

t('D1: checkPersistence resolves nulls (never rejects) when quota breaks every probe', async () => {
  let persistCalls = 0;
  const env = {
    navigator: {
      storage: {
        async persisted() {
          throw quotaError();
        },
        async estimate() {
          throw quotaError();
        },
        async persist() {
          persistCalls++;
          return true;
        },
      },
    },
  };
  const status = await checkPersistence(env);
  assert.equal(status.persisted, null);
  assert.equal(status.estimate, null);
  assert.equal(persistCalls, 0, 'read-only probe must never request the grant');
});

t('D2: ensurePersistence resolves (never rejects) when persist() throws quota', async () => {
  __resetPersistenceMemo();
  const env = {
    navigator: {
      storage: {
        async persisted() {
          return false;
        },
        async persist() {
          throw quotaError();
        },
      },
    },
  };
  const result = await ensurePersistence(env);
  assert.equal(result.requested, true);
  assert.equal(result.persisted, false);
  __resetPersistenceMemo();
});

t('D3: store saves never throw on quota exhaustion (data loss must not crash the app)', async () => {
  const { saveEntries, saveSettings, saveLastOpen } = await import('../js/store.js');
  const throwing = () => {
    throw quotaError();
  };
  globalThis.localStorage = { getItem: () => null, setItem: throwing, removeItem: () => {} };
  try {
    assert.doesNotThrow(() => saveEntries({ '2026-07-01': day('2026-07-01', { moveBody: true }) }), 'saveEntries threw on quota');
    assert.doesNotThrow(() => saveSettings({ schemaVersion: 2 }), 'saveSettings threw on quota');
    assert.doesNotThrow(() => saveLastOpen('2026-07-01'), 'saveLastOpen threw on quota');
  } finally {
    delete globalThis.localStorage;
  }
});

t('D4: partial write failure preserves the last good readable snapshot', async () => {
  const mod = await import('../js/store.js');
  const goodEntries = { '2026-07-01': day('2026-07-01', { moveBody: true }) };
  const vault = new Map([['momentum.entries', JSON.stringify(goodEntries)]]);
  let failWrites = false;
  globalThis.localStorage = {
    getItem: (k) => (vault.has(k) ? vault.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw quotaError();
      vault.set(k, String(v));
    },
    removeItem: (k) => vault.delete(k),
  };
  try {
    assert.deepEqual(mod.loadEntries(), goodEntries);
    failWrites = true;
    try {
      mod.saveEntries({ '2026-07-02': day('2026-07-02', { drinkWater: true }) });
    } catch {
      // Tolerated only if the old snapshot stays intact and readable.
    }
    assert.deepEqual(mod.loadEntries(), goodEntries, 'failed write corrupted the readable snapshot');
  } finally {
    delete globalThis.localStorage;
  }
});

// ---------- E. Merge/persistence hardening extras ----------

t('E1: merged output shares no references with inputs (array/object fields isolated)', () => {
  const local = {
    '2026-07-01': { date: '2026-07-01', tags: ['a'], meta: { src: 'phone' }, flag: true, updatedAt: '2026-07-01T10:00:00.000Z' },
  };
  const remote = {
    '2026-07-01': { date: '2026-07-01', tags: ['b'], meta: { src: 'tablet' }, flag: false, updatedAt: '2026-07-01T12:00:00.000Z' },
  };
  const { merged } = mergeEntries(local, remote);
  const m = merged['2026-07-01'];
  assert.notEqual(m.tags, local['2026-07-01'].tags);
  assert.notEqual(m.tags, remote['2026-07-01'].tags);
  assert.notEqual(m.meta, local['2026-07-01'].meta);
  assert.notEqual(m.meta, remote['2026-07-01'].meta);
  if (Array.isArray(m.tags)) m.tags.push('MUT');
  if (m.meta && typeof m.meta === 'object') m.meta.src = 'MUT';
  assert.deepEqual(local['2026-07-01'].tags, ['a'], 'mutating merged polluted local input');
  assert.deepEqual(remote['2026-07-01'].tags, ['b'], 'mutating merged polluted remote input');
  assert.equal(local['2026-07-01'].meta.src, 'phone');
  assert.equal(remote['2026-07-01'].meta.src, 'tablet');
});

t('E2: sync push degrades to an error status instead of rejecting on malformed server JSON', async () => {
  const sync = await import('../js/sync.js');
  const realFetch = globalThis.fetch;
  let status = null;
  sync.setStatusListener((s) => {
    status = s;
  });
  globalThis.fetch = async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  try {
    await sync.pushNow({ owner: 'o', repo: 'r', path: 'p', token: 't' }, { '2026-07-01': day('2026-07-01') });
  } finally {
    if (realFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = realFetch;
    sync.setStatusListener(null);
  }
  assert.ok(status === 'error' || status === 'offline', `expected error/offline status, got ${status}`);
});

t('E3: merge never throws on corrupt shapes (nulls, primitives, arrays, missing stamps)', () => {
  assert.deepEqual(mergeEntries(null, undefined).merged, {});
  assert.deepEqual(mergeEntries('nope', 42).merged, {});
  const mixed = mergeEntries(
    { '2026-07-01': 'corrupt', '2026-07-02': ['x'] },
    { '2026-07-01': day('2026-07-01', { moveBody: true }), '2026-07-03': null }
  );
  assert.equal(mixed.merged['2026-07-01'].moveBody, true);
  const noStamps = mergeEntries(
    { '2026-07-01': { date: '2026-07-01', moveBody: true, note: 'a' } },
    { '2026-07-01': { date: '2026-07-01', moveBody: false, note: 'b' } }
  );
  assert.equal(noStamps.merged['2026-07-01'].moveBody, true);
  assert.equal(typeof noStamps.merged['2026-07-01'].note, 'string');
  assert.equal(mergeDayEntry(undefined, undefined), undefined);
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed${fail ? ` (${failures.join('; ')})` : ''}`);
  process.exit(fail ? 1 : 0);
});
