// GitHub Contents API sync. Fetch only — no DOM access. Tracks lastSha
// internally so app.js can stay a thin caller. Failed pushes need no retry
// queue: the next resume's pull-merge detects unpushed local entries and
// reschedules the push.

import { todayISO } from './dates.js';
import { mergeEntries } from './merge.js';
import { sanitizeEntries } from './importer.js';

let lastSha = null;
// Last-synced snapshot both sides diverged from. Updated on every
// successful pull and every successful push, so conflict merges can run as
// true three-way merges (mergeEntries local/remote/base) instead of
// timestamp-only two-way merges. Null until the first sync completes, in
// which case callers fall back to the two-way merge.
let syncBase = null;
let pushTimer = null;
let statusListener = null;
let remoteUpdateListener = null;

// Push epoch: bumped on every push entry, schedule, and pull. A 409-retry
// adopts its merged result (and notifies the app) only when the epoch is
// still current, so a local edit that landed mid-push is never overwritten
// by a stale merge. Stale merges update sha/base bookkeeping silently and
// let the next push/resume converge.
let pushEpoch = 0;
// Single in-flight push guard: parallel read-modify-write cycles on
// lastSha/syncBase are never run; the second caller is deferred.
let pushBusy = false;

const SYNC_BASE_KEY = 'momentum.syncBase';
const LAST_SHA_KEY = 'momentum.lastSha';

function lsGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function lsRemove(key) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    // Read-only stub: nothing to clear.
  }
}

function persistBase() {
  if (syncBase == null) {
    lsRemove(SYNC_BASE_KEY);
    return true;
  }
  try {
    return lsSet(SYNC_BASE_KEY, JSON.stringify(syncBase));
  } catch {
    return false;
  }
}

function persistSha() {
  if (lastSha == null) {
    lsRemove(LAST_SHA_KEY);
    return true;
  }
  return lsSet(LAST_SHA_KEY, String(lastSha));
}

function hydrateFromStorage() {
  try {
    const rawBase = lsGet(SYNC_BASE_KEY);
    if (rawBase) {
      const parsed = JSON.parse(rawBase);
      if (typeof parsed === 'object' && parsed !== null) syncBase = parsed;
    }
    const rawSha = lsGet(LAST_SHA_KEY);
    if (rawSha) lastSha = rawSha;
  } catch {
    // Corrupt persisted state: fall back to memory-only (two-way merge).
  }
}

hydrateFromStorage();

function snapshot(entries) {
  return JSON.parse(JSON.stringify(entries ?? {}));
}

export function getSyncBase() {
  return syncBase ? snapshot(syncBase) : null;
}

export function setSyncBase(entries) {
  syncBase = entries == null ? null : snapshot(entries);
  persistBase();
}

export function getLastSha() {
  return lastSha;
}

export function clearSyncState() {
  lastSha = null;
  syncBase = null;
  lsRemove(SYNC_BASE_KEY);
  lsRemove(LAST_SHA_KEY);
}

function notify(status, message) {
  if (statusListener) statusListener(status, message);
}

export function setStatusListener(fn) {
  statusListener = fn;
}

export function setRemoteUpdateListener(fn) {
  remoteUpdateListener = fn;
}

// Byte length of the would-be PUT payload. The full-history PUT can exceed
// the ~64 KB background-fetch comfort zone on large histories; callers use
// this for diagnostics. Durability never depends on it: the next resume
// pull-merge heals anything the unload push could not send.
export function payloadBytes(entries) {
  try {
    const json = JSON.stringify({ version: 1, entries: entries ?? {} });
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(json).length;
    return json.length;
  } catch {
    return -1;
  }
}

function buildUrl(cfg) {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`;
}

function decodeBase64Utf8(content) {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export async function pull(cfg, opts = {}) {
  // A fresh pull invalidates in-flight push adopts (see pushEpoch), except
  // for the pull issued by the 409-retry itself, which belongs to that push.
  if (!opts.internal) pushEpoch++;
  const url = buildUrl(cfg);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
      },
    });
  } catch {
    const err = new Error('Network error while syncing');
    err.code = 'offline';
    throw err;
  }

  if (res.status === 404) {
    // No remote file yet: reset base/sha (memory + persisted) so a later
    // file does not 3-way against a phantom snapshot.
    lastSha = null;
    syncBase = null;
    persistSha();
    persistBase();
    return { entries: {}, sha: null, skipped: 0 };
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('GitHub authorization failed');
    err.code = 'auth';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`GitHub pull failed (${res.status})`);
    err.code = 'error';
    throw err;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error('Malformed GitHub response');
    err.code = 'error';
    throw err;
  }
  let parsed;
  try {
    const decoded = decodeBase64Utf8(body.content);
    parsed = JSON.parse(decoded);
  } catch {
    const err = new Error('Malformed GitHub response');
    err.code = 'error';
    throw err;
  }
  // Boundary sanitizer: hostile or malformed remote keys never reach the
  // merge layer or storage. Rejected keys are counted, never merged.
  const { entries: clean, skipped } = sanitizeEntries(parsed.entries);
  lastSha = body.sha ?? lastSha;
  syncBase = snapshot(clean);
  persistSha();
  persistBase();
  return { entries: clean, sha: body.sha ?? null, skipped };
}

async function putContent(cfg, entries, sha, keepalive = false) {
  const url = buildUrl(cfg);
  const json = JSON.stringify({ version: 1, entries });
  const content = encodeBase64Utf8(json);
  return fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    keepalive: keepalive || undefined,
    body: JSON.stringify({
      message: `momentum ${todayISO()}`,
      content,
      sha: sha ?? undefined,
    }),
  });
}

async function doPush(cfg, entries, opts = {}) {
  if (pushBusy) {
    // Serialize: never run two read-modify-write pushes in parallel. The
    // running push (or the next resume) converges; re-schedule when the
    // caller can supply fresh entries.
    pushEpoch++;
    if (opts.reschedule) schedulePush(cfg, opts.reschedule);
    return { deferred: true };
  }
  pushBusy = true;
  const epoch = ++pushEpoch;
  const snap = snapshot(entries);
  const isCurrent = () => pushEpoch === epoch;
  notify('syncing');

  let res;
  try {
    res = await putContent(cfg, snap, lastSha, opts.keepalive === true);
  } catch {
    pushBusy = false;
    notify('offline');
    return { deferred: false };
  }

  if (res.status === 200 || res.status === 201) {
    try {
      const body = await res.json();
      lastSha = body.content?.sha ?? lastSha;
      syncBase = snapshot(snap);
      persistSha();
      persistBase();
      pushBusy = false;
      if (!isCurrent()) {
        if (opts.reschedule) schedulePush(cfg, opts.reschedule);
        return { deferred: false };
      }
      notify('synced');
    } catch {
      pushBusy = false;
      notify('error', 'Malformed GitHub response');
      // Recover the true server SHA instead of holding a stale one: a
      // best-effort re-pull refreshes sha/base when the network allows.
      try {
        await pull(cfg, { internal: true });
      } catch {
        // Keep the error status; the next resume heals.
      }
    }
    return { deferred: false };
  }

  if (res.status === 409 || res.status === 422) {
    // Capture the base BEFORE the pull below: pull refreshes syncBase to
    // the remote snapshot, which would collapse the 3-way into a 2-way
    // against remote itself (a remote-only field would read as locally
    // deleted and be dropped).
    const baseBefore = syncBase ? snapshot(syncBase) : null;
    try {
      const remote = await pull(cfg, { internal: true });
      const { merged, localChanged, remoteChanged } = mergeEntries(snap, remote.entries, baseBefore);
      const retryRes = await putContent(cfg, merged, remote.sha, opts.keepalive === true);
      if (retryRes.status === 200 || retryRes.status === 201) {
        const retryBody = await retryRes.json();
        lastSha = retryBody.content?.sha ?? remote.sha;
        syncBase = snapshot(merged);
        persistSha();
        persistBase();
        pushBusy = false;
        if (!isCurrent()) {
          // A newer local edit landed mid-push: never overwrite it with
          // this stale merge. Bookkeeping above already tracks the server
          // truth; the follow-up push converges the new edit.
          if (opts.reschedule) schedulePush(cfg, opts.reschedule);
          return { deferred: false };
        }
        notify('synced');
        if ((localChanged || remoteChanged) && remoteUpdateListener) remoteUpdateListener(merged);
        return { deferred: false };
      }
      pushBusy = false;
      notify('error', `GitHub push failed (${retryRes.status})`);
    } catch (err) {
      pushBusy = false;
      if (err && err.code === 'offline') {
        notify('offline');
      } else {
        notify('error', (err && err.message) || 'GitHub sync error');
      }
    }
    return { deferred: false };
  }

  pushBusy = false;
  if (res.status === 401 || res.status === 403) {
    notify('error', 'GitHub authorization failed');
    return { deferred: false };
  }

  notify('error', `GitHub push failed (${res.status})`);
  return { deferred: false };
}

export function schedulePush(cfg, getEntries) {
  pushEpoch++;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    let entries;
    try {
      entries = getEntries();
    } catch (err) {
      notify('error', err?.message);
      return;
    }
    Promise.resolve(doPush(cfg, entries, { reschedule: getEntries })).catch((err) =>
      notify('error', err?.message)
    );
  }, 3000);
}

export async function pushNow(cfg, entries, opts = {}) {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  // Best-effort unload path (hidden tab): keepalive lets the send survive
  // page hide on small payloads. Large histories may still be dropped by
  // the platform; the next resume pull-merge heals.
  await doPush(cfg, entries, { keepalive: true, reschedule: opts.reschedule });
}

// Test-only hook: resets module state between cases.
export function __resetSyncState() {
  lastSha = null;
  syncBase = null;
  pushEpoch = 0;
  pushBusy = false;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  statusListener = null;
  remoteUpdateListener = null;
  lsRemove(SYNC_BASE_KEY);
  lsRemove(LAST_SHA_KEY);
}
