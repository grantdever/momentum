// Full-restore import: habit definitions come back with their original ids,
// so imported history stays attached. Round-trips export -> import -> export
// between two simulated devices. All habit names here are made up.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportString, loadSettings, APP_VERSION } from '../js/store.js';
import { parseImport, isEmptyDevice, planSettingsRestore, restoreSummary, importableSettings } from '../js/importer.js';
import { mergeEntries } from '../js/merge.js';
import { freshSettings, defaultSettings } from '../js/migrate.js';
import { activeHabitsOn } from '../js/habits.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok: ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL: ${name}`);
    console.error(err && err.message ? err.message : err);
  }
}

// Device A: a lived-in install. Archived habit, a weekly quota with a plan,
// a habit added later, non-default preferences, and a sync token.
function deviceA() {
  const settings = {
    ...defaultSettings(),
    habits: [
      { id: 'stretchMorning', label: 'Stretch in the morning', cadence: 'daily-core', active: [{ from: null, to: null }] },
      { id: 'readPages', label: 'Read ten pages', cadence: 'daily-core', active: [{ from: null, to: '2026-08-01' }, { from: '2026-08-15', to: null }], plan: { anchor: 'get into bed', coping: "I'll pick it up the next day." } },
      { id: 'longWalk', label: 'Long walk', cadence: 'weekly-quota', weeklyTarget: 3, active: [{ from: null, to: null }] },
      { id: 'waterPlants', label: 'Water the plants', cadence: 'bonus', active: [{ from: '2026-09-01', to: null }] },
      { id: 'oldPractice', label: 'Practice scales', cadence: 'daily-core', active: [{ from: null, to: '2026-07-20' }] },
    ],
    coreSlack: 0,
    weekStartsOn: 'sunday',
    sleepTargetTime: '23:15',
    holdToComplete: true,
    github: { enabled: true, owner: 'someone', repo: 'habit-data', path: 'data.json', token: 'fake-device-a-token' },
  };
  const entries = {};
  const stamp = '2026-09-30T21:00:00.000Z';
  const days = ['2026-07-10', '2026-07-19', '2026-08-02', '2026-08-20', '2026-09-03', '2026-09-30'];
  days.forEach((date, i) => {
    entries[date] = {
      date,
      stretchMorning: i % 2 === 0,
      readPages: date < '2026-08-01' || date >= '2026-08-15',
      longWalk: i % 3 === 0,
      oldPractice: date < '2026-07-20',
      offDay: i === 3,
      note: i === 5 ? 'rainy' : '',
      updatedAt: stamp,
    };
    if (date >= '2026-09-01') entries[date].waterPlants = true;
  });
  return { settings, entries };
}

// What app.js's import handler does, minus the DOM.
function applyImport(local, json) {
  const result = parseImport(json);
  assert.equal(result.error, undefined, result.error);
  const empty = isEmptyDevice(local.entries, local.settings);
  const restore = planSettingsRestore(local.settings, result.settings, empty);
  const { merged } = mergeEntries(local.entries, result.entries);
  return { settings: restore.settings, entries: merged, restore, result };
}

function habitIdsIn(entries) {
  const meta = new Set(['date', 'offDay', 'note', 'updatedAt', 'frozen']);
  const ids = new Set();
  for (const e of Object.values(entries)) for (const k of Object.keys(e)) if (!meta.has(k)) ids.add(k);
  return ids;
}

function payloadOf(json) {
  const p = JSON.parse(json);
  delete p.exportedAt;
  return p;
}

t('round-trip: export A -> import on an empty device B -> export B is identical (bar origin/time/token)', () => {
  const a = deviceA();
  const exportA = exportString(a.entries, a.settings, 'https://old.example/momentum/');
  const b = applyImport({ entries: {}, settings: freshSettings() }, exportA);
  assert.equal(b.restore.mode, 'full');
  const exportB = exportString(b.entries, b.settings, 'https://new.example/');
  const pa = payloadOf(exportA);
  const pb = payloadOf(exportB);
  assert.deepEqual(pb.entries, pa.entries);
  assert.deepEqual(pb.settings.habits, pa.settings.habits);
  for (const k of ['coreSlack', 'weekStartsOn', 'sleepTargetTime', 'holdToComplete', 'schemaVersion']) {
    assert.deepEqual(pb.settings[k], pa.settings[k], k);
  }
  // Sync config is device-local: B keeps its own (empty) block, A's is not imported.
  assert.deepEqual(pb.settings.github, freshSettings().github);
  assert.equal(pb.exportedFrom, 'https://new.example/');
  assert.equal(pa.exportedFrom, 'https://old.example/momentum/');
});

t('round-trip: a second hop (B -> C) is still lossless', () => {
  const a = deviceA();
  const b = applyImport({ entries: {}, settings: freshSettings() }, exportString(a.entries, a.settings));
  const c = applyImport({ entries: {}, settings: freshSettings() }, exportString(b.entries, b.settings));
  assert.deepEqual(c.entries, a.entries);
  assert.deepEqual(c.settings.habits, a.settings.habits);
});

t('full restore keeps original habit ids, so no logged history is orphaned', () => {
  const a = deviceA();
  const b = applyImport({ entries: {}, settings: freshSettings() }, exportString(a.entries, a.settings));
  const defined = new Set(b.settings.habits.map((h) => h.id));
  for (const id of habitIdsIn(b.entries)) assert.ok(defined.has(id), `history for "${id}" has no habit`);
  assert.deepEqual(
    b.settings.habits.map((h) => h.id),
    ['stretchMorning', 'readPages', 'longWalk', 'waterPlants', 'oldPractice']
  );
});

t('full restore keeps active intervals (archived stays archived, gaps stay gaps)', () => {
  const a = deviceA();
  const b = applyImport({ entries: {}, settings: freshSettings() }, exportString(a.entries, a.settings));
  const ids = (date) => activeHabitsOn(b.settings.habits, date).map((h) => h.id);
  assert.ok(!ids('2026-10-01').includes('oldPractice'));
  assert.ok(ids('2026-07-01').includes('oldPractice'));
  assert.ok(!ids('2026-08-05').includes('readPages'));
  assert.ok(ids('2026-08-20').includes('readPages'));
  assert.ok(!ids('2026-08-20').includes('waterPlants'));
  const read = b.settings.habits.find((h) => h.id === 'readPages');
  assert.deepEqual(read.plan, a.settings.habits[1].plan);
  assert.equal(b.settings.habits.find((h) => h.id === 'longWalk').weeklyTarget, 3);
});

t('full restore through the real fresh-install path (loadSettings on empty storage)', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const local = { entries: {}, settings: loadSettings() };
    assert.equal(local.settings.onboarding, 'pending');
    const a = deviceA();
    const b = applyImport(local, exportString(a.entries, a.settings));
    assert.equal(b.restore.mode, 'full');
    assert.equal(b.settings.onboarding, undefined, 'restore leaves the setup wizard');
    assert.equal(b.settings.habits.length, 5);
  } finally {
    delete globalThis.localStorage;
  }
});

t('the sync token is never imported, even when the export carries one', () => {
  const a = deviceA();
  // A hand-edited export that still has the token in it.
  const payload = JSON.parse(exportString(a.entries, a.settings));
  payload.settings.github.token = 'fake-leaked-token';
  const json = JSON.stringify(payload);
  const parsed = parseImport(json);
  assert.equal(JSON.stringify(parsed).includes('fake-leaked-token'), false);
  const local = { entries: {}, settings: freshSettings() };
  local.settings.github = { enabled: true, owner: 'me', repo: 'mine', path: 'data.json', token: 'fake-local-token' };
  const b = applyImport(local, json);
  assert.equal(b.settings.github.token, 'fake-local-token');
  assert.equal(b.settings.github.repo, 'mine');
  // And exports themselves always blank the token.
  assert.equal(JSON.parse(exportString(a.entries, a.settings)).settings.github.token, '');
});

t('hostile settings: bad habits, reserved ids, proto keys and junk preferences are dropped', () => {
  const json =
    '{"entries":{"2026-09-01":{"date":"2026-09-01","goodOne":true,"updatedAt":"2026-09-01T00:00:00.000Z"}},' +
    '"settings":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},' +
    '"habits":[{"id":"goodOne","label":"Good one","cadence":"daily-core","active":[{"from":null,"to":null}]},' +
    '{"id":"date","label":"Reserved","cadence":"daily-core"},{"id":"noLabel","cadence":"daily-core"},' +
    '{"id":"badCadence","label":"X","cadence":"hourly"},"not-a-habit",' +
    '{"id":"goodOne","label":"Duplicate","cadence":"bonus"}],' +
    '"coreSlack":"banana","weekStartsOn":"someday","holdToComplete":"yes","onboarding":"pending","extra":"<script>"}}';
  const res = parseImport(json);
  assert.equal(res.error, undefined);
  assert.deepEqual(Object.keys(res.settings).sort(), ['coreSlack', 'habits', 'holdToComplete', 'sleepTargetTime', 'weekStartsOn']);
  assert.deepEqual(res.settings.habits.map((h) => h.id), ['goodOne']);
  assert.equal(res.settings.habits[0].label, 'Good one');
  const d = defaultSettings();
  assert.equal(res.settings.coreSlack, d.coreSlack);
  assert.equal(res.settings.weekStartsOn, d.weekStartsOn);
  assert.equal(res.settings.holdToComplete, d.holdToComplete);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

t('non-empty device: imported habits missing locally are added; local labels and prefs win', () => {
  const a = deviceA();
  const local = {
    settings: {
      ...defaultSettings(),
      habits: [{ id: 'readPages', label: 'My own label', cadence: 'daily-core', active: [{ from: '2026-10-01', to: null }] }],
      coreSlack: 2,
      weekStartsOn: 'monday',
    },
    entries: { '2026-10-02': { date: '2026-10-02', readPages: true, updatedAt: '2026-10-02T12:00:00.000Z' } },
  };
  const b = applyImport(local, exportString(a.entries, a.settings));
  assert.equal(b.restore.mode, 'merge');
  assert.equal(b.restore.habitsAdded, 4);
  const read = b.settings.habits.find((h) => h.id === 'readPages');
  assert.equal(read.label, 'My own label');
  assert.deepEqual(read.active, [{ from: '2026-10-01', to: null }]);
  assert.equal(b.settings.habits[0].id, 'readPages', 'local order kept, imports appended');
  assert.equal(b.settings.coreSlack, 2);
  assert.equal(b.settings.weekStartsOn, 'monday');
  assert.ok(b.entries['2026-10-02'].readPages);
  assert.ok(b.entries['2026-07-10']);
});

t('importing the same file twice changes nothing the second time', () => {
  const a = deviceA();
  const json = exportString(a.entries, a.settings);
  const once = applyImport({ entries: {}, settings: freshSettings() }, json);
  const twice = applyImport({ entries: once.entries, settings: once.settings }, json);
  assert.equal(twice.restore.mode, 'merge');
  assert.equal(twice.restore.habitsAdded, 0);
  assert.deepEqual(twice.settings, once.settings);
  assert.deepEqual(twice.entries, once.entries);
});

t('a v16-era export (no appVersion/exportedFrom) restores the same way', () => {
  const a = deviceA();
  const legacy = JSON.parse(exportString(a.entries, a.settings));
  delete legacy.appVersion;
  delete legacy.exportedFrom;
  const b = applyImport({ entries: {}, settings: freshSettings() }, JSON.stringify(legacy));
  assert.equal(b.restore.mode, 'full');
  assert.deepEqual(b.settings.habits, a.settings.habits);
});

t('an entries-only file restores days but leaves settings alone', () => {
  const a = deviceA();
  const json = JSON.stringify({ entries: a.entries });
  const local = { entries: {}, settings: freshSettings() };
  const b = applyImport(local, json);
  assert.equal(b.result.settings, null);
  assert.equal(b.restore.mode, 'entries');
  assert.deepEqual(b.settings, local.settings);
});

t('a backup with zero habits keeps the setup wizard pending', () => {
  const s = { ...defaultSettings(), habits: [] };
  const json = exportString({ '2026-09-01': { date: '2026-09-01', updatedAt: '2026-09-01T00:00:00.000Z' } }, s);
  const b = applyImport({ entries: {}, settings: freshSettings() }, json);
  assert.equal(b.settings.onboarding, 'pending');
});

t('planSettingsRestore never mutates its inputs', () => {
  const a = deviceA();
  const local = { ...defaultSettings(), habits: [] , onboarding: 'pending' };
  const localCopy = JSON.parse(JSON.stringify(local));
  const imported = importableSettings(a.settings);
  const importedCopy = JSON.parse(JSON.stringify(imported));
  planSettingsRestore(local, imported, true);
  planSettingsRestore(local, imported, false);
  assert.deepEqual(local, localCopy);
  assert.deepEqual(imported, importedCopy);
});

t('restoreSummary: "Restored N days (first–last), M habits."', () => {
  const a = deviceA();
  assert.equal(restoreSummary(a.entries, 5), 'Restored 6 days (2026-07-10–2026-09-30), 5 habits.');
  assert.equal(restoreSummary({ '2026-01-01': {} }, 1), 'Restored 1 day (2026-01-01–2026-01-01), 1 habit.');
});

t('exports carry appVersion, and it matches the service worker cache name', () => {
  const p = JSON.parse(exportString({}, defaultSettings(), 'https://x.example/'));
  assert.equal(p.appVersion, APP_VERSION);
  assert.equal(p.exportedFrom, 'https://x.example/');
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const m = sw.match(/const CACHE = 'honest-streaks-(v\d+)'/);
  assert.ok(m, 'sw.js CACHE name not found');
  assert.equal(m[1], APP_VERSION);
});

t('isEmptyDevice: only no days AND no habits counts as empty', () => {
  assert.equal(isEmptyDevice({}, freshSettings()), true);
  assert.equal(isEmptyDevice({ '2026-01-01': {} }, freshSettings()), false);
  assert.equal(isEmptyDevice({}, defaultSettings()), false);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
