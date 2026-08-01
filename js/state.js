/* ===========================================================================
   state.js — the single owner of application state.
   Replaces ~25 `window.*` globals from the original file. Nothing else
   assigns to these fields directly; use the exported mutators.
   =========================================================================== */

/* --------------------------------------------------------------------------
   Datasets
   -------------------------------------------------------------------------- */

export const datasets = {
  flashcard: [],        // raw-topics.json         ids B1..B477
  mcq: [],              // mcq.json                ids Q1..Q1001
  'mcq-study': [],      // derived from mcq.json    (shares Q ids by design)
  'mixed-topic': [],    // mixed-topic.json        ids M1..M275
  'latest-important': [],
  'key-tables': []
};

/* Every record from every dataset, indexed by unique id. */
export const recordsById = new Map();

/* legacyKey (the original question text) -> [uniqueId, ...].
   A legacy key can map to several ids: the source data contains 70 duplicate
   question strings inside single arrays and 85 that collide between the MCQ
   and Mixed-Topic sets. The old app keyed all user state by that string, so
   those cards genuinely shared one record — the migration below preserves
   that behaviour rather than silently picking a winner. */
export const idsByLegacyKey = new Map();

/* --------------------------------------------------------------------------
   Cloud-synced user state — all keyed by UNIQUE ID (B1/Q1/M1/L1/T1), never by
   question text. See migrateCloudDoc() for backward compatibility.
   -------------------------------------------------------------------------- */

export const cloud = {
  flags: {},          // { [id]: number[] }                       flag types 1-6
  updates: {},        // { [id]: { text, media } }                "More Info" workspace
  chapters: {},       // { [id]: string }                         flag 4 editor
  diagrams: {},       // { [id]: { img, comment, link } }         flag 5 editor
  studyMaterial: {}   // { [folderName]: Array<{text, link, img}> }
};

/* --------------------------------------------------------------------------
   Session / UI state
   -------------------------------------------------------------------------- */

export const ui = {
  mode: 'flashcard',
  filterType: 'all',        // 'all' | '1'..'6'
  searchTerm: '',
  bookFilter: 'all',
  chapterFilter: 'all',
  mixedTopic: 'all',
  mixedOptionsVisible: false,
  rangeValue: 'all',
  shuffled: false,
  allExpanded: false,
  currentFolder: null,
  editingNoteIndex: null,
  tempNoteImg: null,
  sfxEnabled: true,
  speechRate: 1.0,
  bookStructure: {},        // { [book]: Set<chapter> }
  /* Expanded-card ids, namespaced per mode. Bug #12: the original kept one
     un-namespaced Set keyed on the rendered number, so Book Topics #5 and
     Study QA #5 expanded together. */
  expandedByMode: Object.create(null),
  /* Items currently rendered in each container. */
  visibleItems: [],
  currentMCQItems: [],
  /* MCQ scoreboard — Mixed Topic keeps its own tally so it cannot pollute
     the exam score (bug #23). */
  score: { mcq: { correct: 0, attempts: 0 }, 'mixed-topic': { correct: 0, attempts: 0 } }
};

export function expandedSet(mode = ui.mode) {
  if (!ui.expandedByMode[mode]) ui.expandedByMode[mode] = new Set();
  return ui.expandedByMode[mode];
}

/* --------------------------------------------------------------------------
   Local-only preferences (localStorage). Purely additive — the original app
   stored nothing locally, so there is no legacy format to preserve.
   -------------------------------------------------------------------------- */

const PREF_KEY = 'gcexam.prefs.v1';

export const prefs = {
  sfxEnabled: true,
  speechRate: 1.0,
  lastMode: 'flashcard',
  lastBook: 'all',
  lastChapter: 'all'
};

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    Object.assign(prefs, JSON.parse(raw) || {});
  } catch (_) { /* private mode / disabled storage — defaults are fine */ }
  ui.sfxEnabled = prefs.sfxEnabled !== false;
  ui.speechRate = Number(prefs.speechRate) || 1.0;
}

export function savePrefs(patch) {
  Object.assign(prefs, patch);
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
}

/* --------------------------------------------------------------------------
   Data loading
   -------------------------------------------------------------------------- */

const FILES = {
  flashcard: 'data/raw-topics.json',
  mcq: 'data/mcq.json',
  'mixed-topic': 'data/mixed-topic.json',
  'latest-important': 'data/latest-important.json',
  'key-tables': 'data/key-tables.json'
};

/* The card badge shows the same number the original app showed:
   plain integers for Book Topics (B) and MCQ/Study QA (Q), and the prefixed
   form for Mixed Topic / Latest Important / Key Tables. Keeping this identical
   matters because "jump to number" is typed against it (bug #25). */
function displayIdFor(id) {
  const prefix = id[0];
  const n = id.slice(1);
  return (prefix === 'B' || prefix === 'Q') ? n : id;
}

function indexRecord(rec) {
  recordsById.set(rec.id, rec);
  const list = idsByLegacyKey.get(rec.legacyKey);
  if (list) list.push(rec.id);
  else idsByLegacyKey.set(rec.legacyKey, [rec.id]);
}

export async function loadData() {
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([key, url]) => {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
      return [key, await res.json()];
    })
  );

  for (const [key, arr] of entries) {
    for (const rec of arr) rec.displayId = displayIdFor(rec.id);
    datasets[key] = arr;
    arr.forEach(indexRecord);
  }

  /* mcqStudyData stays derived at runtime (analysis.md §6.2) so 1001 entries
     are not duplicated on disk. It shares the Q ids with the MCQ set on
     purpose: it is the same question, so flags should be shared. */
  datasets['mcq-study'] = datasets.mcq.map((item) => ({
    id: item.id,
    displayId: item.displayId,
    legacyKey: item.legacyKey,
    q: item.q,
    a: `${item.options[item.correct]} [Source: ${item.source}]`,
    source: item.source
  }));

  return datasets;
}

/* Mixed Topic rendered as study cards uses the same derived shape. */
export function toStudyShape(item) {
  return {
    id: item.id,
    displayId: item.displayId,
    legacyKey: item.legacyKey,
    q: item.q,
    a: `${item.options[item.correct]} [Source: ${item.source}]`,
    source: item.source
  };
}

/* --------------------------------------------------------------------------
   BACKWARD-COMPATIBLE KEY MIGRATION  (analysis.md bug #7)
   --------------------------------------------------------------------------
   The original app keyed flags / chapters / diagrams / updates by the raw
   question TEXT. That collides: 70 duplicate questions within single arrays,
   85 shared between MCQ and Mixed Topic, 2 between Book Topics and Key Tables.
   This build keys everything by a globally-unique id (B/Q/M/L/T + number).

   The user's existing Firestore document is still keyed by question text, and
   we must not break it. So on every read we normalise:

     - a key that is already a known unique id  -> kept as-is
     - a key that matches a record's legacyKey  -> copied onto EVERY id that
       shares that legacy text (preserving the old shared-record behaviour)
     - a key that matches neither               -> kept verbatim, so data for
       questions we no longer recognise is never dropped

   Migration happens on read only. Writes always use unique ids, so the
   document converts itself over time without a destructive one-shot rewrite.
   Old keys linger harmlessly until overwritten; they still resolve because a
   legacyKey lookup runs on every read.
   -------------------------------------------------------------------------- */

function migrateMap(remote) {
  const out = Object.create(null);
  if (!remote || typeof remote !== 'object') return out;

  const legacyPending = [];

  for (const [key, value] of Object.entries(remote)) {
    if (value === undefined || value === null) continue;

    if (recordsById.has(key)) {            // already a unique id — authoritative
      out[key] = value;
      continue;
    }

    const ids = idsByLegacyKey.get(key);   // legacy question-text key
    if (ids) { legacyPending.push([ids, value]); continue; }

    out[key] = value;                      // unknown key — never discard it
  }

  // Legacy values only fill ids that have no modern value yet.
  for (const [ids, value] of legacyPending) {
    for (const id of ids) if (!(id in out)) out[id] = value;
  }

  return out;
}

export function migrateCloudDoc(data) {
  return {
    flags: migrateMap(data && data.flags),
    updates: migrateMap(data && data.updates),
    chapters: migrateMap(data && data.chapters),
    diagrams: migrateMap(data && data.diagrams),
    // Study material is keyed by folder name, not question text — no migration.
    studyMaterial: (data && data.studyMaterial) || {}
  };
}

export function applyCloudDoc(data) {
  const migrated = migrateCloudDoc(data);
  cloud.flags = migrated.flags;
  cloud.updates = migrated.updates;
  cloud.chapters = migrated.chapters;
  cloud.diagrams = migrated.diagrams;
  cloud.studyMaterial = migrated.studyMaterial;
  return migrated;
}

/* --------------------------------------------------------------------------
   Offline mirror.
   The original app had no local persistence at all, so nothing the user had
   written was available offline (bug #79). We keep a copy of the synced maps
   in localStorage: it is read at startup (before Firestore connects) and
   overwritten whenever cloud state changes. Firestore remains authoritative.
   -------------------------------------------------------------------------- */

const MIRROR_KEY = 'gcexam.cloud-mirror.v1';

export function saveMirror() {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({
      flags: cloud.flags,
      updates: cloud.updates,
      chapters: cloud.chapters,
      diagrams: cloud.diagrams,
      studyMaterial: cloud.studyMaterial,
      savedAt: Date.now()
    }));
  } catch (_) { /* quota exceeded (base64 images) — the cloud copy still holds */ }
}

export function loadMirror() {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return false;
    applyCloudDoc(JSON.parse(raw));
    return true;
  } catch (_) { return false; }
}

/* --------------------------------------------------------------------------
   Flag helpers — always keyed by unique id.
   -------------------------------------------------------------------------- */

export function flagsFor(item) {
  const raw = cloud.flags[item.id];
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === '') return [];
  return [Number(raw)];
}

export function setFlags(item, flags) {
  if (!flags || flags.length === 0) delete cloud.flags[item.id];
  else cloud.flags[item.id] = flags;
}

export function chapterFor(item) { return cloud.chapters[item.id] || ''; }
export function diagramFor(item) { return cloud.diagrams[item.id] || { img: '', comment: '', link: '' }; }
export function updateFor(item)  { return cloud.updates[item.id]  || { text: '', media: '' }; }

/* --------------------------------------------------------------------------
   Link safety (bug #1) — only http(s) URLs may reach an href/src attribute.
   -------------------------------------------------------------------------- */

export function safeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const v = value.trim();
  if (/^data:image\//i.test(v)) return v;          // our own compressed uploads
  try {
    const url = new URL(v, window.location.href);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
  } catch (_) {
    return '';
  }
}

/* --------------------------------------------------------------------------
   Tiny pub/sub so firebase-sync can notify the UI without importing it.
   -------------------------------------------------------------------------- */

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (err) { console.error(`listener for "${event}" failed`, err); }
  }
}
