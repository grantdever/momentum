// Storage persistence guard for the installed PWA. Pure probes plus one
// fire-and-forget request; this module never throws and never blocks load.
//
// Background: on iOS a home-screen web app lives under storage pressure —
// under low-disk conditions WebKit may evict site data (including the Cache
// API copies the service worker keeps and the localStorage entries the app
// keeps) unless the origin holds a persistent-storage grant. The grant is
// advisory on WebKit (the platform may still evict), so this module treats
// persistence as defense in depth: request the grant where the
// StorageManager API exists, report what the platform actually granted, and
// probe which durable fallback (OPFS, IndexedDB) is available so future
// work can mirror critical data there. It never changes app behavior based
// on the answer — sync and export remain the durable copies.
//
// Every function accepts an injectable environment object so unit tests can
// drive WebKit-shaped, Chromium-shaped, and bare (no-API) configurations
// without browser globals. When omitted, the functions probe globalThis
// defensively (safe to import and call in node, workers, and old Safari).
// Only this module and store.js touch browser globals.

function envOf(overrides) {
  if (overrides && typeof overrides === 'object') return overrides;
  if (typeof globalThis !== 'undefined') return globalThis;
  return {};
}

// True when running inside an installed home-screen app: iOS Safari exposes
// navigator.standalone, other platforms match display-mode: standalone.
export function isStandalonePWA(env) {
  const e = envOf(env);
  try {
    if (e.navigator && e.navigator.standalone === true) return true;
    if (typeof e.matchMedia === 'function' && e.matchMedia('(display-mode: standalone)').matches) {
      return true;
    }
  } catch {
    // A throwing matchMedia stub is still "not standalone".
  }
  return false;
}

// Synchronous capability probe. Returns which durability APIs exist; it
// makes no async calls and never touches storage contents.
export function getPersistenceSupport(env) {
  const e = envOf(env);
  const storage = e.navigator && e.navigator.storage ? e.navigator.storage : undefined;
  let opfs = false;
  try {
    opfs = !!(storage && typeof storage.getDirectory === 'function');
  } catch {
    opfs = false;
  }
  let indexedDB = false;
  try {
    indexedDB = !!e.indexedDB;
  } catch {
    indexedDB = false;
  }
  return {
    storageManager: !!storage,
    persistFn: !!(storage && typeof storage.persist === 'function'),
    persistedQuery: !!(storage && typeof storage.persisted === 'function'),
    estimateFn: !!(storage && typeof storage.estimate === 'function'),
    opfs,
    indexedDB,
  };
}

// Which local fallback could hold a durable mirror, in preference order.
// 'none' means localStorage is the only store — sync/export stay the backup.
export function persistenceFallbackAvailable(env) {
  const support = getPersistenceSupport(env);
  if (support.opfs) return 'opfs';
  if (support.indexedDB) return 'indexeddb';
  return 'none';
}

// Read-only status check: current grant state plus quota estimate. Never
// requests anything and never throws; `persisted` is null when the platform
// cannot answer (notably WebKit, which often lacks persisted()).
export async function checkPersistence(env) {
  const e = envOf(env);
  const storage = e.navigator && e.navigator.storage ? e.navigator.storage : undefined;
  let persisted = null;
  try {
    if (storage && typeof storage.persisted === 'function') {
      persisted = await storage.persisted();
    }
  } catch {
    persisted = null;
  }
  let estimate = null;
  try {
    if (storage && typeof storage.estimate === 'function') {
      const raw = await storage.estimate();
      estimate = {
        quota: typeof raw.quota === 'number' ? raw.quota : null,
        usage: typeof raw.usage === 'number' ? raw.usage : null,
      };
    }
  } catch {
    estimate = null;
  }
  return {
    persisted,
    estimate,
    standalone: isStandalonePWA(e),
    fallback: persistenceFallbackAvailable(e),
  };
}

// Request the persistent-storage grant when the API exists. Safe to call on
// every launch: it short-circuits when already granted, resolves (never
// rejects) on platforms without the API, and serializes concurrent calls
// made during the same session into one underlying request.
let inflightRequest = null;

export function ensurePersistence(env) {
  if (inflightRequest) return inflightRequest;
  inflightRequest = (async () => {
    const e = envOf(env);
    const support = getPersistenceSupport(e);
    const status = await checkPersistence(e);
    if (status.persisted === true) {
      return { requested: false, persisted: true, alreadyGranted: true, fallback: status.fallback };
    }
    if (!support.persistFn) {
      return { requested: false, persisted: status.persisted, alreadyGranted: false, fallback: status.fallback };
    }
    try {
      const granted = await e.navigator.storage.persist();
      return { requested: true, persisted: granted === true, alreadyGranted: false, fallback: status.fallback };
    } catch {
      return { requested: true, persisted: false, alreadyGranted: false, fallback: status.fallback };
    }
  })();
  const release = () => {
    inflightRequest = null;
  };
  inflightRequest.then(release, release);
  return inflightRequest;
}

// Test-only hook: clears the memoized in-flight request between cases.
export function __resetPersistenceMemo() {
  inflightRequest = null;
}
