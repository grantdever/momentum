// GitHub Contents API sync. Fetch only — no DOM access. Tracks lastSha
// internally so app.js can stay a thin caller. Failed pushes need no retry
// queue: the next resume's pull-merge detects unpushed local entries and
// reschedules the push.

import { todayISO } from './dates.js';
import { mergeEntries } from './merge.js';

let lastSha = null;
let pushTimer = null;
let statusListener = null;
let remoteUpdateListener = null;

function notify(status, message) {
  if (statusListener) statusListener(status, message);
}

export function setStatusListener(fn) {
  statusListener = fn;
}

export function setRemoteUpdateListener(fn) {
  remoteUpdateListener = fn;
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

export async function pull(cfg) {
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
    return { entries: {}, sha: null };
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

  const body = await res.json();
  const decoded = decodeBase64Utf8(body.content);
  const parsed = JSON.parse(decoded);
  lastSha = body.sha;
  return { entries: parsed.entries ?? {}, sha: body.sha };
}

async function putContent(cfg, entries, sha) {
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
    body: JSON.stringify({
      message: `momentum ${todayISO()}`,
      content,
      sha: sha ?? undefined,
    }),
  });
}

async function doPush(cfg, entries) {
  notify('syncing');

  let res;
  try {
    res = await putContent(cfg, entries, lastSha);
  } catch {
    notify('offline');
    return;
  }

  if (res.status === 200 || res.status === 201) {
    const body = await res.json();
    lastSha = body.content?.sha ?? lastSha;
    notify('synced');
    return;
  }

  if (res.status === 409 || res.status === 422) {
    try {
      const remote = await pull(cfg);
      const { merged, remoteChanged } = mergeEntries(entries, remote.entries);
      const retryRes = await putContent(cfg, merged, remote.sha);
      if (retryRes.status === 200 || retryRes.status === 201) {
        const retryBody = await retryRes.json();
        lastSha = retryBody.content?.sha ?? remote.sha;
        notify('synced');
        if (remoteChanged && remoteUpdateListener) remoteUpdateListener(merged);
        return;
      }
      notify('error', `GitHub push failed (${retryRes.status})`);
    } catch (err) {
      if (err && err.code === 'offline') {
        notify('offline');
      } else {
        notify('error', (err && err.message) || 'GitHub sync error');
      }
    }
    return;
  }

  if (res.status === 401 || res.status === 403) {
    notify('error', 'GitHub authorization failed');
    return;
  }

  notify('error', `GitHub push failed (${res.status})`);
}

export function schedulePush(cfg, getEntries) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    doPush(cfg, getEntries());
  }, 3000);
}

export async function pushNow(cfg, entries) {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  await doPush(cfg, entries);
}
