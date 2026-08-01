/* ===========================================================================
   firebase-sync.js — Firestore wiring.

   Architecture is unchanged from the original: one shared document
   `quizData/shared` holding { flags, updates, chapters, diagrams,
   studyMaterial }, no Auth. What IS fixed here:

     #5  `setDoc(..., { merge: true })` could never delete a key, so "Clear all
         flags", "Delete folder" and "Remove image" silently came back on the
         next snapshot. We now write the FULL document.
     #26 `window.saveToCloud` was defined by a deferred CDN module, so every
         call before it loaded threw and lost the user's edit. `saveToCloud`
         is exported synchronously and queues writes until the SDK is ready.
     #27 `onSnapshot` had no error callback, so permission/offline failures
         were invisible. There is now an error handler and a status pill.
     #6  All write errors surface in the UI, not just `resource-exhausted`.
     #10 The snapshot handler no longer calls stopAudio() or rebuilds the DOM.
   =========================================================================== */

import { firebaseConfig, SDK_VERSION, COLLECTION, DOCUMENT } from './firebase-config.js';
import { cloud, applyCloudDoc, emit } from './state.js';

const APP_URL = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`;
const FS_URL = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`;

let docRef = null;
let setDocFn = null;
let ready = false;

/* Write coalescing + offline queue -----------------------------------------
   Edits are frequent (every keystroke-blur on a textarea). We debounce, and
   if a write fails or we are offline we keep retrying with backoff. Because
   every write sends the FULL document, a queued write is always "the latest
   state" — there is nothing to merge and no ordering hazard. */
let pendingTimer = null;
let retryTimer = null;
let retryDelay = 2000;
let dirty = false;
let inFlight = false;

const SAVE_DEBOUNCE = 600;

function setStatus(state, message) {
  emit('sync-status', { state, message });
}

function snapshotState() {
  return {
    flags: cloud.flags,
    updates: cloud.updates,
    chapters: cloud.chapters,
    diagrams: cloud.diagrams,
    studyMaterial: cloud.studyMaterial
  };
}

async function flush() {
  if (!ready || inFlight || !dirty) return;
  inFlight = true;
  dirty = false;

  try {
    // NO merge:true — a full-document write is what makes deletions stick (#5).
    await setDocFn(docRef, snapshotState());
    retryDelay = 2000;
    setStatus('synced', 'Saved');
  } catch (err) {
    console.error('Firestore write failed', err);
    dirty = true; // keep the change queued

    let message = 'Changes are saved on this device and will sync when possible.';
    if (err && err.code === 'resource-exhausted') {
      message = 'Cloud storage limit reached. Delete some images to keep syncing.';
    } else if (err && err.code === 'invalid-argument') {
      // 1 MiB document cap — base64 images are the usual culprit (#6).
      message = 'This document is too large to save (images use a lot of space). Remove an image and try again.';
    } else if (err && err.code === 'permission-denied') {
      message = 'Cloud sync rejected the write (permission denied).';
    }
    setStatus('error', message);

    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryDelay = Math.min(retryDelay * 2, 60000); flush(); }, retryDelay);
  } finally {
    inFlight = false;
    if (dirty && ready && !retryTimer) scheduleFlush();
  }
}

function scheduleFlush() {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flush, SAVE_DEBOUNCE);
}

/**
 * Queue a full-document sync. Safe to call before the SDK has loaded, while
 * offline, or hundreds of times in a row.
 */
export function saveToCloud() {
  dirty = true;
  if (!ready) { setStatus('pending', 'Waiting for cloud connection…'); return; }
  if (!navigator.onLine) { setStatus('offline', 'Offline — changes will sync later.'); return; }
  scheduleFlush();
}

export function isReady() { return ready; }
export function hasPendingWrites() { return dirty; }

window.addEventListener('online', () => {
  if (dirty) { clearTimeout(retryTimer); retryTimer = null; retryDelay = 2000; flush(); }
  else setStatus('synced', 'Online');
});
window.addEventListener('offline', () => setStatus('offline', 'Offline — changes will sync later.'));

/* Best effort: try to push anything outstanding before the tab goes away. */
window.addEventListener('pagehide', () => { if (dirty && ready) flush(); });

/* --------------------------------------------------------------------------
   Initialisation
   -------------------------------------------------------------------------- */

export async function initSync() {
  setStatus('connecting', 'Connecting…');
  try {
    const [{ initializeApp }, fs] = await Promise.all([import(APP_URL), import(FS_URL)]);
    const { getFirestore, doc, onSnapshot, setDoc } = fs;

    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    docRef = doc(db, COLLECTION, DOCUMENT);
    setDocFn = setDoc;
    ready = true;

    /* The SDK handles is deliberately NOT exported to window (bug #4): the
       original leaked db/doc/setDoc/onSnapshot globally, handing any injected
       script a ready-made write handle. */

    onSnapshot(
      docRef,
      (docSnap) => {
        if (!docSnap.exists()) {
          setDoc(docRef, { flags: {}, updates: {}, chapters: {}, diagrams: {}, studyMaterial: {} })
            .catch((err) => console.error('Failed to create shared document', err));
          setStatus('synced', 'Ready');
          return;
        }

        /* Do not clobber local edits that have not reached the server yet. */
        if (dirty || inFlight) { setStatus('pending', 'Saving…'); return; }

        // applyCloudDoc runs the legacyKey -> unique-id migration (state.js).
        applyCloudDoc(docSnap.data());
        setStatus(docSnap.metadata.fromCache ? 'offline' : 'synced', 'Synced');

        /* Bug #10: this used to call applyRangeFilter(), which called
           stopAudio() and rebuilt the entire list on every write — including
           the user's own. Listeners now patch only the cards that changed. */
        emit('cloud-updated', { fromCache: docSnap.metadata.fromCache });
      },
      (error) => {
        console.error('Firestore snapshot error', error);
        setStatus('error', `Cloud sync unavailable (${error.code || 'error'}). Your work is kept on this device.`);
      }
    );

    if (dirty) scheduleFlush();
  } catch (err) {
    console.error('Firebase failed to initialise', err);
    ready = false;
    setStatus('error', 'Cloud sync could not start. The app works offline; changes are kept locally.');
  }
}
