// Sync-layer regression suite: pull/push state handling, 409-retry
// generation guard, pull-side sanitizing, persisted base/sha, and the
// deterministic tie-break reunion. Fetch-mocked; no network. Run with:
//   node tests/test-sync.js

import assert from 'node:assert/strict';
import { mergeEntries } from '../js/merge.js';
import { sanitizeEntries, parseImport } from '../js/importer.js';
import {
  pull,
  pushNow,
  schedulePush,
  setStatusListener,
  setRemoteUpdateListener,
  getSyncBase,
  setSyncBase,
  getLastSha,
  clearSyncState,
  payloadBytes,
  __resetSyncState,
} from '../js/sync.js';
import {
  loadSyncBase,
  saveSyncBase,
  loadLastSha,
  saveLastSha,
  loadEntries,
  saveEntries,
  saveSettings,
} from '../js/store.js';

let pass = 0;
let fail = 0;
const failures = [];
// Serial queue: sync tests share module state (fetch stub, sync.js
// singletons, localStorage stub), so cases must run one at a time, never
// interleaved.
const queue = [];

function t(name, fn) {
  queue.push([name, fn]);
}

async function runAll() {
  for (const [name, fn] of queue) {
    try {
      await fn();
      pass++;
      console.log(`ok: ${name}`);
    } catch (err) {
      fail++;
      failures.push(name);
      console.error(`FAIL: ${name}`);
      console.error(err && err.message ? err.message : err);
    }
  }
}

const cfg = { owner: 'o', repo: 'r', path: 'data.json', token: 't' };

function day(date, overrides = {}) {
  return { date, note: '', offDay: false, updatedAt: '2026-07-01T00:00:00.000Z', ...overrides };
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function freshStorage() {
  const vault = new Map();
  globalThis.localStorage = {
    getItem: (k) => (vault.has(k) ? vault.get(k) : null),
    setItem: (k, v) => vault.set(k, String(v)),
    removeItem: (k) => vault.delete(k),
  };
  return vault;
}

function dropStorage() {
  delete globalThis.localStorage;
}

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = handler;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

function resetAll() {
  __resetSyncState();
  clearSyncState();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

// ---------- T-sync-1: pull 404 resets entries/sha/base ----------

t('T-sync-1: pull 404 returns empty entries and resets sha+base (memory and persisted)', async () => {
  const vault = freshStorage();
  try {
    resetAll();
    // Seed a healthy state first.
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ content: b64({ version: 1, entries: { '2026-07-01': day('2026-07-01') } }), sha: 'sha-1' }),
    }));
    const first = await pull(cfg);
    assert.equal(first.sha, 'sha-1');
    assert.equal(getLastSha(), 'sha-1');
    assert.deepEqual(getSyncBase(), { '2026-07-01': day('2026-07-01') });
    assert.ok(vault.has('momentum.syncBase') && vault.has('momentum.lastSha'));

    stubFetch(async () => ({ status: 404, ok: false, json: async () => ({}) }));
    const res = await pull(cfg);
    assert.deepEqual(res.entries, {});
    assert.equal(res.sha, null);
    assert.equal(getLastSha(), null);
    assert.equal(getSyncBase(), null);
    assert.ok(!vault.has('momentum.syncBase') && !vault.has('momentum.lastSha'));
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-sync-2: error codes leave state untouched ----------

t('T-sync-2: auth/offline/5xx/malformed pulls throw the right code with state untouched', async () => {
  freshStorage();
  try {
    resetAll();
    setSyncBase({ '2026-07-01': day('2026-07-01') });
    const baseBefore = getSyncBase();

    stubFetch(async () => ({ status: 401, ok: false, json: async () => ({}) }));
    await assert.rejects(pull(cfg), (e) => e.code === 'auth');
    assert.deepEqual(getSyncBase(), baseBefore);

    stubFetch(async () => ({ status: 403, ok: false, json: async () => ({}) }));
    await assert.rejects(pull(cfg), (e) => e.code === 'auth');
    assert.deepEqual(getSyncBase(), baseBefore);

    stubFetch(async () => {
      throw new TypeError('network down');
    });
    await assert.rejects(pull(cfg), (e) => e.code === 'offline');
    assert.deepEqual(getSyncBase(), baseBefore);

    stubFetch(async () => ({ status: 500, ok: false, json: async () => ({}) }));
    await assert.rejects(pull(cfg), (e) => e.code === 'error');
    assert.deepEqual(getSyncBase(), baseBefore);

    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }));
    await assert.rejects(pull(cfg), (e) => e.code === 'error');
    assert.deepEqual(getSyncBase(), baseBefore);

    // Empty remote (no entries field): converges to empty with a recorded sha.
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ content: b64({ version: 1 }), sha: 'sha-empty' }),
    }));
    const empty = await pull(cfg);
    assert.deepEqual(empty.entries, {});
    assert.equal(empty.sha, 'sha-empty');
    assert.equal(getLastSha(), 'sha-empty');
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-sync-3a: legitimate 409 retry adopts ----------

t('T-sync-3a: 409 retry merges and adopts (listener fires, sha+base advance, one synced)', async () => {
  freshStorage();
  try {
    resetAll();
    const local = {
      '2026-07-01': day('2026-07-01', { moveBody: true, note: 'local', updatedAt: '2026-07-01T10:00:00.000Z' }),
    };
    const remoteEntries = {
      '2026-07-01': day('2026-07-01', { drinkWater: true, note: 'remote', updatedAt: '2026-07-01T12:00:00.000Z' }),
      '2026-07-02': day('2026-07-02', { drinkWater: true, updatedAt: '2026-07-01T12:00:00.000Z' }),
    };
    let calls = 0;
    stubFetch(async (url, opts) => {
      calls++;
      if (opts && opts.method === 'PUT') {
        if (calls === 1) return { status: 409, ok: false, json: async () => ({}) };
        return { status: 200, ok: true, json: async () => ({ content: { sha: 'sha-retry' } }) };
      }
      return { status: 200, ok: true, json: async () => ({ content: b64({ version: 1, entries: remoteEntries }), sha: 'sha-remote' }) };
    });
    const statuses = [];
    const adopted = [];
    setStatusListener((s) => statuses.push(s));
    setRemoteUpdateListener((m) => adopted.push(m));

    await pushNow(cfg, local);

    assert.equal(adopted.length, 1);
    assert.equal(adopted[0]['2026-07-01'].moveBody, true);
    assert.equal(adopted[0]['2026-07-01'].drinkWater, true);
    assert.equal(adopted[0]['2026-07-01'].note, 'remote');
    assert.equal(adopted[0]['2026-07-02'].drinkWater, true);
    assert.equal(getLastSha(), 'sha-retry');
    assert.deepEqual(getSyncBase(), adopted[0]);
    assert.equal(statuses.filter((s) => s === 'synced').length, 1);
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-sync-3b (rewritten): 409 retry never clobbers newer local edits ----------

t('T-sync-3b: 409 retry drops a stale adopt when a newer edit landed mid-push', async () => {
  freshStorage();
  try {
    resetAll();
    const snapA = {
      '2026-07-01': day('2026-07-01', { moveBody: true, note: 'A', updatedAt: '2026-07-01T10:00:00.000Z' }),
    };
    const remoteEntries = {
      '2026-07-01': day('2026-07-01', { drinkWater: true, note: 'R', updatedAt: '2026-07-01T11:00:00.000Z' }),
    };
    const newerEntries = {
      '2026-07-01': day('2026-07-01', { moveBody: true, drinkWater: true, note: 'NEWER', updatedAt: '2026-07-01T12:00:00.000Z' }),
    };
    const fetchCalls = [];
    let retryResolve;
    const retryGate = new Promise((res) => {
      retryResolve = res;
    });
    let putCount = 0;
    stubFetch(async (url, opts) => {
      fetchCalls.push(opts && opts.method);
      if (opts && opts.method === 'PUT') {
        putCount++;
        if (putCount === 1) return { status: 409, ok: false, json: async () => ({}) };
        await retryGate;
        return { status: 200, ok: true, json: async () => ({ content: { sha: 'sha-retry' } }) };
      }
      if (fetchCalls.filter((m) => m !== 'PUT').length === 1) {
        return { status: 200, ok: true, json: async () => ({ content: b64({ version: 1, entries: remoteEntries }), sha: 'sha-remote' }) };
      }
      return { status: 200, ok: true, json: async () => ({ content: b64({ version: 1, entries: newerEntries }), sha: 'sha-newer' }) };
    });
    const statuses = [];
    const adopted = [];
    setStatusListener((s) => statuses.push(s));
    setRemoteUpdateListener((m) => adopted.push(m));

    const p = pushNow(cfg, snapA);
    // Wait until the retry PUT is in flight (2 PUTs? no: 1st PUT + 1 GET + retry PUT pending).
    await waitFor(() => putCount === 2);
    // A newer local edit lands mid-push, observed here as a fresh external
    // pull (bumps the push epoch). The stale merge must not overwrite it.
    const fresh = await pull(cfg);
    assert.equal(fresh.entries['2026-07-01'].note, 'NEWER');
    retryResolve();
    await p;

    assert.equal(adopted.length, 0, 'stale 409 merge overwrote a newer local edit');
    assert.ok(!statuses.includes('synced'), 'stale push must not report synced');
    assert.equal(getLastSha(), 'sha-retry');
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-sync-5: debounce + pushNow cancels the timer ----------

t('T-sync-5: schedulePush debounces to one PUT; pushNow cancels the timer (no parallel PUT)', async () => {
  freshStorage();
  try {
    resetAll();
    const entries = { '2026-07-01': day('2026-07-01') };
    let putCount = 0;
    let lastOpts = null;
    stubFetch(async (url, opts) => {
      if (opts && opts.method === 'PUT') {
        putCount++;
        lastOpts = opts;
        return { status: 200, ok: true, json: async () => ({ content: { sha: `sha-${putCount}` } }) };
      }
      return { status: 200, ok: true, json: async () => ({ content: b64({ version: 1, entries }), sha: 'sha-x' }) };
    });
    setStatusListener(null);
    setRemoteUpdateListener(null);

    schedulePush(cfg, () => entries);
    schedulePush(cfg, () => entries);
    await pushNow(cfg, entries);
    assert.equal(putCount, 1, 'pushNow must cancel the pending debounce timer');
    assert.equal(lastOpts.keepalive, true, 'unload-path push is best-effort keepalive');
    await sleep(3300);
    assert.equal(putCount, 1, 'cancelled timer fired a second PUT');
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-sync-6: keepalive best-effort + payload size probe ----------

t('T-sync-6: payload size grows with history (keepalive fallback documented)', () => {
  const small = { '2026-07-01': day('2026-07-01') };
  const big = {};
  for (let d = 1; d <= 60; d++) {
    const key = `2026-01-${String(d).padStart(2, '0')}`;
    big[key] = day(key, { moveBody: true, note: 'x'.repeat(200) });
  }
  const s = payloadBytes(small);
  const b = payloadBytes(big);
  assert.ok(s > 0 && b > s, `expected growth, got small=${s} big=${b}`);
});

// ---------- malformed-success recovery (F6r gating subset) ----------

t('T-sync-9: malformed push-success JSON keeps an error status and recovers sha via re-pull', async () => {
  freshStorage();
  try {
    resetAll();
    const entries = { '2026-07-01': day('2026-07-01') };
    const recovered = { '2026-07-01': day('2026-07-01', { moveBody: true }) };
    let calls = 0;
    stubFetch(async (url, opts) => {
      calls++;
      if (opts && opts.method === 'PUT') {
        return {
          status: 200,
          ok: true,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        };
      }
      return { status: 200, ok: true, json: async () => ({ content: b64({ version: 1, entries: recovered }), sha: 'sha-rec' }) };
    });
    const statuses = [];
    setStatusListener((s) => statuses.push(s));
    setRemoteUpdateListener(null);

    await pushNow(cfg, entries);

    assert.ok(statuses.includes('error'), `expected error status, got ${JSON.stringify(statuses)}`);
    assert.ok(!statuses.includes('synced'), 'malformed success must not report synced');
    assert.equal(getLastSha(), 'sha-rec', 're-pull must recover the true server sha');
    assert.deepEqual(getSyncBase(), recovered);
    assert.ok(calls >= 2, 'expected a recovery pull after the malformed body');
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-sync-10: pull-side sanitizer ----------

t('T-sync-10: pull rejects hostile day keys with a count (no merge, no pollution)', async () => {
  freshStorage();
  try {
    resetAll();
    const good = day('2026-07-01', { moveBody: true });
    const rawEntries = JSON.parse(
      '{"2026-07-01":{"date":"2026-07-01","moveBody":true,"note":"","offDay":false,"updatedAt":"2026-07-01T00:00:00.000Z"},"__proto__":{"polluted":true},"not-a-date":{"date":"x"},"2026-07-02":"nope","constructor":{"x":1}}'
    );
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ content: b64({ version: 1, entries: rawEntries }), sha: 'sha-s' }),
    }));
    const res = await pull(cfg);
    assert.deepEqual(Object.keys(res.entries), ['2026-07-01']);
    assert.deepEqual(res.entries['2026-07-01'], good);
    assert.equal(res.skipped, 4);
    assert.equal({}.polluted, undefined, 'prototype pollution leaked to Object.prototype');
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.entries, '__proto__'),
      false
    );
    // Sanitized base persists: nothing hostile reaches storage-backed state.
    assert.deepEqual(getSyncBase(), { '2026-07-01': good });
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-merge-6: tied-stamp reunion converges ----------

t('T-merge-6: tied-stamp scalar edits converge identically from both sides, reunion included', () => {
  const stamp = '2026-07-01T10:00:00.000Z';
  const a = { '2026-07-01': day('2026-07-01', { note: 'alpha', updatedAt: stamp }) };
  const b = { '2026-07-01': day('2026-07-01', { note: 'beta', updatedAt: stamp }) };
  const mAB = mergeEntries(a, b).merged;
  const mBA = mergeEntries(b, a).merged;
  assert.deepEqual(mAB, mBA, 'tied merge diverges by argument order');
  assert.equal(mAB['2026-07-01'].note, 'beta', 'lexical max must win ties');
  const reunionA = mergeEntries(mAB, mBA).merged;
  const reunionB = mergeEntries(mBA, mAB).merged;
  assert.deepEqual(reunionA, mAB);
  assert.deepEqual(reunionB, mAB);
});

// ---------- T-merge-1: persisted base keeps 3-way precision across reload ----------

t('T-merge-1: persisted sync base round-trips and preserves a deliberate uncheck', () => {
  freshStorage();
  try {
    resetAll();
    const base = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T08:00:00.000Z' }) };
    assert.equal(saveSyncBase(base), true);
    assert.equal(saveLastSha('sha-base'), true);
    // "Reload": read back through the storage-backed loaders.
    const reloaded = loadSyncBase();
    assert.deepEqual(reloaded, base);
    assert.equal(loadLastSha(), 'sha-base');

    const unchecker = { '2026-07-01': day('2026-07-01', { moveBody: false, updatedAt: '2026-07-01T09:00:00.000Z' }) };
    const staleTrue = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T12:00:00.000Z' }) };
    assert.equal(mergeEntries(unchecker, staleTrue, reloaded).merged['2026-07-01'].moveBody, false);
    // Without the base the same inputs stay true-wins (documented trade-off).
    assert.equal(mergeEntries(unchecker, staleTrue).merged['2026-07-01'].moveBody, true);
  } finally {
    dropStorage();
    resetAll();
  }
});

// ---------- T-adv-1: hostile keys rejected at the import boundary ----------

t('T-adv-1: hostile import keys are rejected with a count, good days preserved', () => {
  const good = day('2026-07-01', { moveBody: true });
  const payload = JSON.parse(
    '{"entries":{"2026-07-01":{"date":"2026-07-01","moveBody":true,"note":"","offDay":false,"updatedAt":"2026-07-01T00:00:00.000Z"},"__proto__":{"polluted":true},"zzz":"junk"}}'
  );
  const res = parseImport(JSON.stringify(payload));
  assert.equal(res.error, undefined);
  assert.deepEqual(res.entries, { '2026-07-01': good });
  assert.equal(res.skipped, 2);
  assert.equal({}.polluted, undefined);
  const direct = sanitizeEntries(payload.entries);
  assert.equal(direct.skipped, 2);
  assert.deepEqual(Object.keys(direct.entries), ['2026-07-01']);
});

// ---------- T-adv-2: push/pull interleave never loses a completion ----------

t('T-adv-2: conflicting boolean completions union through the 409 path', async () => {
  freshStorage();
  try {
    resetAll();
    const local = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: '2026-07-01T10:00:00.000Z' }) };
    const remoteEntries = { '2026-07-01': day('2026-07-01', { drinkWater: true, updatedAt: '2026-07-01T12:00:00.000Z' }) };
    let n = 0;
    stubFetch(async (url, opts) => {
      n++;
      if (opts && opts.method === 'PUT') {
        if (n === 1) return { status: 409, ok: false, json: async () => ({}) };
        return { status: 200, ok: true, json: async () => ({ content: { sha: 'sha-ok' } }) };
      }
      return { status: 200, ok: true, json: async () => ({ content: b64({ version: 1, entries: remoteEntries }), sha: 'sha-r' }) };
    });
    const adopted = [];
    setStatusListener(null);
    setRemoteUpdateListener((m) => adopted.push(m));
    await pushNow(cfg, local);
    assert.equal(adopted.length, 1);
    assert.equal(adopted[0]['2026-07-01'].moveBody, true);
    assert.equal(adopted[0]['2026-07-01'].drinkWater, true);
  } finally {
    restoreFetch();
    dropStorage();
    resetAll();
  }
});

// ---------- T-adv-4: quota-false path surfaces instead of silent loss ----------

t('T-adv-4: quota failures return false and preserve the last good snapshot', async () => {
  const goodEntries = { '2026-07-01': day('2026-07-01', { moveBody: true }) };
  const vault = new Map([['momentum.entries', JSON.stringify(goodEntries)]]);
  const quotaErr = () => {
    const e = new Error('QuotaExceededError');
    e.name = 'QuotaExceededError';
    throw e;
  };
  globalThis.localStorage = {
    getItem: (k) => (vault.has(k) ? vault.get(k) : null),
    setItem: () => quotaErr(),
    removeItem: (k) => vault.delete(k),
  };
  try {
    assert.equal(saveEntries({ '2026-07-02': day('2026-07-02') }), false);
    assert.equal(saveSettings({ schemaVersion: 2 }), false);
    assert.equal(saveSyncBase(goodEntries), false);
    assert.equal(saveLastSha('x'), false);
    assert.deepEqual(loadEntries(), goodEntries, 'failed write corrupted the readable snapshot');
  } finally {
    dropStorage();
  }
});

// ---------- boolean-boundary pin (merge stays schema-agnostic) ----------

t('T-merge-3: non-boolean habit values merge last-writer-wins by stamp (pinned, not broadened)', () => {
  const older = '2026-07-01T10:00:00.000Z';
  const newer = '2026-07-01T12:00:00.000Z';
  const numOld = { '2026-07-01': day('2026-07-01', { moveBody: 0, updatedAt: older }) };
  const numNew = { '2026-07-01': day('2026-07-01', { moveBody: 1, updatedAt: newer }) };
  assert.equal(mergeEntries(numOld, numNew).merged['2026-07-01'].moveBody, 1);
  assert.equal(mergeEntries(numNew, numOld).merged['2026-07-01'].moveBody, 1);
  const strOld = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: older }) };
  const strNew = { '2026-07-01': day('2026-07-01', { moveBody: 'done', updatedAt: newer }) };
  assert.equal(mergeEntries(strOld, strNew).merged['2026-07-01'].moveBody, 'done');
  assert.equal(mergeEntries(strNew, strOld).merged['2026-07-01'].moveBody, 'done');
  // Both-boolean stays true-wins regardless of stamps.
  const f = { '2026-07-01': day('2026-07-01', { moveBody: false, updatedAt: newer }) };
  const tt = { '2026-07-01': day('2026-07-01', { moveBody: true, updatedAt: older }) };
  assert.equal(mergeEntries(f, tt).merged['2026-07-01'].moveBody, true);
  assert.equal(mergeEntries(tt, f).merged['2026-07-01'].moveBody, true);
});

// ---------- multi-tab last-writer-wins pin ----------

t('N3: concurrent tabs are last-writer-wins (pinned, next resume heals)', () => {
  freshStorage();
  try {
    resetAll();
    const a = { '2026-07-01': day('2026-07-01', { moveBody: true }) };
    const b = { '2026-07-02': day('2026-07-02', { drinkWater: true }) };
    assert.equal(saveEntries(a), true);
    assert.equal(saveEntries(b), true);
    assert.deepEqual(loadEntries(), b);
    assert.equal(saveSyncBase(a), true);
    assert.equal(saveSyncBase(b), true);
    assert.deepEqual(loadSyncBase(), b);
  } finally {
    dropStorage();
    resetAll();
  }
});

runAll().then(() => {
  console.log(`\n${pass} passed, ${fail} failed${fail ? ` (${failures.join('; ')})` : ''}`);
  process.exit(fail ? 1 : 0);
});
