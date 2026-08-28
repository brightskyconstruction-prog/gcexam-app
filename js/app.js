/* ===========================================================================
   app.js — bootstrap, mode switching and ALL event wiring.

   There is not a single inline `onclick` / `onchange` / `onkeyup` attribute in
   this build. Every interaction is delegated from three listeners on
   `document` (click / change / input) that read a `data-action` attribute and
   resolve the owning record through `data-id`. That removes the entire class
   of "a question containing a quote breaks the card" bugs (#2) and, together
   with textContent rendering, the stored-XSS surface (#1).
   =========================================================================== */

import {
  ui, cloud, prefs, recordsById, loadData, loadPrefs, savePrefs, on,
  flagsFor, setFlags, safeUrl, toStudyShape, expandedSet,
  loadMirror, saveMirror
} from './state.js';
import { MODES, getMode, isStudyView, baseData } from './modes.js';
import { computeList, rangeOptions, resetShuffle, reshuffle } from './filters.js';
import { buildBookStructure, naturalSort } from './parse-source.js';
import {
  els, cacheEls, startChunkedRender, cancelRender, buildStudyCard, buildMCQCard,
  patchCard, findCard, toast, resolveConfirm, openModal, closeModal,
  trapFocus, topModal, emptyState, flagLabel
} from './render.js';
import {
  playSound, vibrate, toggleSFX, initVoices, initSpeed, primeVoice, initAudio,
  togglePlay, stopAudio, skip, jumpToNumber, cycleSpeed,
  player, setPlayerIndex, releaseAudio
} from './audio.js';
import {
  renderStudyMaterials, renderFolderView, createNewFolder, deleteFolder,
  renameFolder, openFolder, openAddNoteModal, editNote, closeAddNoteModal,
  saveNoteFromModal, deleteNote, handleModalImage, compressImage
} from './study-material.js';
import { initSync, saveToCloud } from './firebase-sync.js';

/* ==========================================================================
   Persistence helper
   ========================================================================== */

function persist() {
  saveMirror();
  saveToCloud();
}

/* ==========================================================================
   Rendering the active list
   ========================================================================== */

/**
 * Recompute the filtered list and render it.
 * `preserveAudio` is set by the cloud-sync path so a background write can
 * never stop playback (bug #10).
 */
export function refresh({ keepScroll = false } = {}) {
  const mode = getMode(ui.mode);
  const view = mode.view();

  if (view === 'material') {
    if (ui.currentFolder) renderFolderView(ui.currentFolder);
    else renderStudyMaterials();
    return;
  }

  const scrollY = keepScroll ? window.scrollY : null;
  const list = computeList();

  /* Bug #43: the inactive container is emptied, so we never hold ~1,500 card
     nodes at once. */
  if (view === 'mcq') {
    els['quiz-list'].textContent = '';
    els['quiz-list'].classList.add('is-hidden');
    els['mcq-view'].classList.add('is-active');

    ui.currentMCQItems = list;
    ui.visibleItems = list;
    startChunkedRender(els['mcq-view'], list, buildMCQCard);
    if (ui.mode === 'mcq') updateScoreboard();
  } else {
    els['mcq-view'].textContent = '';
    els['mcq-view'].classList.remove('is-active');
    els['quiz-list'].classList.remove('is-hidden');

    // Mixed Topic in text mode renders its MCQs as study cards.
    const items = (ui.mode === 'mixed-topic') ? list.map(toStudyShape) : list;
    ui.visibleItems = items;
    ui.currentMCQItems = items;
    startChunkedRender(els['quiz-list'], items, buildStudyCard);
  }

  if (player.index >= ui.visibleItems.length) setPlayerIndex(0);
  updateJumpInput();

  if (scrollY !== null) window.scrollTo({ top: scrollY, behavior: 'auto' });
}

/* Bug #25: the jump box now advertises the same numbering the cards print,
   so "T7" in Key Tables and "5" in Book Topics both do what they look like. */
function updateJumpInput() {
  const input = els.jumpInput;
  if (!input) return;

  const list = isStudyView() ? ui.visibleItems : ui.currentMCQItems;
  if (list.length === 0) {
    input.placeholder = '#';
    input.setAttribute('aria-label', 'Jump to question number');
    return;
  }

  const first = String(list[0].displayId);
  const last = String(list[list.length - 1].displayId);
  const numeric = /^\d+$/.test(first);

  input.placeholder = `${first}-${last}`;
  input.inputMode = numeric ? 'numeric' : 'text';
  input.setAttribute('aria-label', `Jump to question number, between ${first} and ${last}`);
}

/* ==========================================================================
   Control population
   ========================================================================== */

/* Explicit element creation rather than the implicit `new Option(...)`
   global — clearer, and it keeps the module testable outside a browser. */
function option(label, value) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function populateBooksAndChapters() {
  const mode = getMode(ui.mode);
  if (!mode.controls.bookChapter) return;

  ui.bookStructure = buildBookStructure(baseData());

  const select = els.bookFilter;
  select.textContent = '';
  select.appendChild(option('📚 All Books', 'all'));
  Object.keys(ui.bookStructure).sort(naturalSort).forEach((book) => {
    select.appendChild(option(book, book));
  });
  select.value = 'all';

  els.chapterFilter.textContent = '';
  els.chapterFilter.appendChild(option('📖 All Chapters', 'all'));
  els.chapterFilter.disabled = true;
}

function populateRangeDropdown() {
  const select = els.rangeSelect;
  select.textContent = '';
  select.appendChild(option('All Questions', 'all'));
  for (const { value, label } of rangeOptions()) select.appendChild(option(label, value));
  select.value = 'all';
  ui.rangeValue = 'all';
}

function handleBookChange() {
  ui.bookFilter = els.bookFilter.value;
  ui.chapterFilter = 'all';

  const chapters = ui.bookStructure[ui.bookFilter];
  els.chapterFilter.textContent = '';
  els.chapterFilter.appendChild(option('📖 All Chapters', 'all'));

  if (ui.bookFilter !== 'all' && chapters) {
    els.chapterFilter.disabled = false;
    Array.from(chapters).sort(naturalSort).forEach((chap) => {
      els.chapterFilter.appendChild(option(chap, chap));
    });
  } else {
    els.chapterFilter.disabled = true;
  }

  savePrefs({ lastBook: ui.bookFilter, lastChapter: 'all' });
  refresh();
}

/* On a cold start only, re-apply the book/chapter filter the user last chose.
   Switching modes deliberately still resets it, matching the original app. */
function restoreLastFilters() {
  if (!getMode(ui.mode).controls.bookChapter) return;
  if (!prefs.lastBook || prefs.lastBook === 'all') return;
  if (!ui.bookStructure[prefs.lastBook]) return;

  els.bookFilter.value = prefs.lastBook;
  handleBookChange();

  if (prefs.lastChapter && prefs.lastChapter !== 'all' && ui.bookStructure[prefs.lastBook].has(prefs.lastChapter)) {
    els.chapterFilter.value = prefs.lastChapter;
    ui.chapterFilter = prefs.lastChapter;
    refresh();
  }
}

/* ==========================================================================
   Mode switching
   ========================================================================== */

export function switchMode(modeId) {
  if (!MODES[modeId]) return;
  playSound('click');
  stopAudio();
  cancelRender();

  ui.mode = modeId;
  savePrefs({ lastMode: modeId });
  document.body.dataset.mode = modeId;

  const mode = getMode(modeId);
  const c = mode.controls;

  // Reset per-mode filter state (matches the original's behaviour).
  ui.filterType = 'all';
  ui.searchTerm = '';
  ui.bookFilter = 'all';
  ui.chapterFilter = 'all';
  ui.allExpanded = false;
  ui.currentFolder = null;
  setPlayerIndex(0);
  resetShuffle();

  els.searchInput.value = '';
  document.querySelectorAll('.filter-chip[data-type]').forEach((chip) => {
    const active = chip.dataset.type === 'all';
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  // Mode buttons: aria-pressed is the accessible state, `.primary` the look.
  for (const m of Object.values(MODES)) {
    const btn = document.getElementById(m.button);
    if (!btn) continue;
    const active = m.id === modeId;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (m.id === 'mixed-topic' || m.id === 'material') continue; // keep their own gradient
    btn.classList.toggle('primary', active);
  }

  // Control visibility.
  els['flashcard-controls'].classList.toggle('is-hidden', !(c.search || c.flagChips || c.range || c.bookChapter));
  els['mixed-topic-controls'].classList.toggle('is-hidden', !c.mixed);
  els.searchInput.classList.toggle('is-hidden', !c.search);
  els.flagChips.classList.toggle('is-hidden', !c.flagChips);
  document.querySelector('.filter-dual-row').classList.toggle('is-hidden', !c.bookChapter);
  els.rangeSelect.classList.toggle('is-hidden', !c.range);
  els.expandAllBtn.classList.toggle('is-hidden', !c.expand);
  els.shuffleBtn.classList.toggle('is-hidden', !c.shuffle);
  els['exam-scoreboard'].classList.toggle('is-visible', c.scoreboard);
  els.audioPlayerContainer.classList.toggle('is-hidden', !c.player);
  syncPlayerGap();
  els.shuffleBtn.setAttribute('aria-pressed', 'false');

  els.expandAllBtn.textContent = (modeId === 'mcq' || (modeId === 'mixed-topic' && ui.mixedOptionsVisible))
    ? '🔽 Show Answer Key'
    : '🔽 Expand All';

  if (c.bookChapter) populateBooksAndChapters();
  if (c.range) populateRangeDropdown();

  if (modeId === 'mcq') resetScore('mcq');
  if (modeId === 'mixed-topic') resetScore('mixed-topic');

  refresh();
}

/* ==========================================================================
   Scoreboard (bugs #23, #24)
   ========================================================================== */

function scoreBucket() {
  return ui.score[ui.mode] || ui.score.mcq;
}

function resetScore(modeId) {
  if (ui.score[modeId]) ui.score[modeId] = { correct: 0, attempts: 0 };
  if (modeId === 'mcq') updateScoreboard();
}

function updateScoreboard() {
  const { correct, attempts } = ui.score.mcq;
  const total = ui.currentMCQItems.length;
  const percent = attempts === 0 ? 0 : Math.round((correct / attempts) * 100);

  // One denominator per figure, instead of mixing them in a single string.
  els.scoreValue.textContent = `${correct} / ${attempts} correct (${percent}%)`;
  els.scoreProgress.textContent = `${attempts} of ${total} answered`;

  const badge = els.levelBadge;
  if (attempts === 0) { badge.textContent = 'Ready to Start'; badge.dataset.level = 'none'; }
  else if (percent >= 80) { badge.textContent = '🏆 Project Manager'; badge.dataset.level = 'good'; }
  else if (percent >= 50) { badge.textContent = '👷 Foreman'; badge.dataset.level = 'mid'; }
  else { badge.textContent = '🧱 Apprentice'; badge.dataset.level = 'low'; }
}

function checkAnswer(card, optIdx) {
  const index = Number(card.dataset.index);
  const item = ui.currentMCQItems[index];
  if (!item) return;

  const options = card.querySelector('.mcq-options');
  if (!options || options.classList.contains('answered')) return;
  options.classList.add('answered');
  Array.from(options.children).forEach((btn) => { btn.disabled = true; });

  const source = card.querySelector('[data-role="source"]');
  if (source) source.classList.add('is-visible');

  const correctIdx = item.correct;
  const chosen = options.children[optIdx];

  if (optIdx === correctIdx) {
    if (chosen) chosen.classList.add('correct');
    playSound('correct');
  } else {
    if (chosen) chosen.classList.add('wrong');
    if (options.children[correctIdx]) options.children[correctIdx].classList.add('correct');
    playSound('wrong');
    vibrate(200);   // now gated by the SFX toggle (bug #41)
  }

  // Bug #23: Mixed Topic keeps its own tally and cannot pollute the exam score.
  const bucket = scoreBucket();
  bucket.attempts += 1;
  if (optIdx === correctIdx) bucket.correct += 1;
  if (ui.mode === 'mcq') updateScoreboard();
}

/* ==========================================================================
   Flags
   ========================================================================== */

function itemFromCard(card) {
  const id = card && card.dataset.id;
  if (!id) return null;
  // Mixed Topic study cards are derived objects, so prefer the rendered list.
  return ui.visibleItems.find((i) => i.id === id) || recordsById.get(id) || null;
}

function setFlag(card, type) {
  const item = itemFromCard(card);
  if (!item) return;
  playSound('click');

  const before = flagsFor(item);
  let flags = before.slice();
  if (type === 0) flags = [];
  else if (flags.includes(type)) flags = flags.filter((f) => f !== type);
  else flags.push(type);
  flags.sort((a, b) => a - b);

  setFlags(item, flags);
  persist();

  closeAllMenus();

  /* Bug #11: patch this one card instead of re-running the whole pipeline.
     A re-filter is only needed when the active flag chip would drop or add
     the card, and even then only when audio is not playing. */
  const filterAffected = ui.filterType !== 'all' && !flags.includes(Number(ui.filterType));
  if (filterAffected && !player.playing) refresh({ keepScroll: true });
  else patchCard(item);

  toast(flagToastMessage(type, before));
}

/** Confirmation text for the toast shown after a flag option is tapped. */
function flagToastMessage(type, previousFlags) {
  if (type === 0) return 'Flags cleared.';
  const label = flagLabel(type) || `Flag ${type}`;
  const wasSet = previousFlags.includes(type);
  return wasSet ? `${label} flag removed.` : `${label} flag added.`;
}

function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown.show').forEach((menu) => {
    menu.classList.remove('show');
    const card = menu.closest('.card');
    if (card) card.classList.remove('menu-open');   // bug #28: guarded
    const btn = menu.parentElement && menu.parentElement.querySelector('.menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

function toggleMenu(btn) {
  playSound('click');
  const wrapper = btn.closest('.menu-wrapper');
  const menu = wrapper && wrapper.querySelector('.menu-dropdown');
  if (!menu) return;

  const willOpen = !menu.classList.contains('show');
  closeAllMenus();
  if (!willOpen) return;

  menu.classList.add('show');
  menu.classList.remove('drop-up');
  btn.setAttribute('aria-expanded', 'true');
  const card = menu.closest('.card');
  if (card) card.classList.add('menu-open');

  // For a card near the bottom of a long list, opening downward would run
  // the menu off the bottom of the screen. Flip it above the button instead.
  // (getBoundingClientRect() is 0 in non-layout test environments, which
  // harmlessly evaluates to "fits" and leaves the menu opening downward.)
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight && rect.height > 0) {
    menu.classList.add('drop-up');
  }
}

async function copyCard(card) {
  const item = itemFromCard(card);
  if (!item) return;
  const text = `Q: ${item.q}\n\nA: ${item.a != null ? item.a : (item.options ? item.options[item.correct] : '')}`;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'visually-hidden';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast('Copied to clipboard.', 'success');
  } catch (err) {
    console.error('copy failed', err);
    toast('Could not copy to the clipboard.', 'error');
  }
  closeAllMenus();
}

/* ==========================================================================
   Share
   ========================================================================== */

function shareData() {
  return {
    title: 'GC Exam Master',
    text: 'GC Exam Master — Georgia General Contractor Exam Study App',
    url: window.location.href
  };
}

/* Native Web Share API first (the OS-level sheet on mobile browsers and most
   modern desktop browsers); a small in-app modal with Copy Link / WhatsApp /
   Email covers everywhere else. No extra libraries either way. */
async function shareApp() {
  playSound('click');
  const data = shareData();

  if (navigator.share) {
    try {
      await navigator.share(data);
    } catch (err) {
      // AbortError just means the user closed the native sheet — not a
      // failure worth reporting.
      if (err && err.name !== 'AbortError') {
        console.warn('share failed, falling back', err);
        openShareFallback();
      }
    }
    return;
  }

  openShareFallback();
}

function openShareFallback() {
  const { text, url } = shareData();
  if (els.shareWhatsapp) els.shareWhatsapp.href = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
  if (els.shareEmail) els.shareEmail.href = `mailto:?subject=${encodeURIComponent('GC Exam Master')}&body=${encodeURIComponent(`${text}\n${url}`)}`;
  openModal(els.shareModal, els.shareModal.querySelector('.icon-btn'));
}

async function copyShareLink() {
  const { url } = shareData();
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      const area = document.createElement('textarea');
      area.value = url;
      area.setAttribute('readonly', '');
      area.className = 'visually-hidden';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast('Link copied!', 'success');
  } catch (err) {
    console.error('copy link failed', err);
    toast('Could not copy the link.', 'error');
  }
}

/* Clicks are delegated through a single listener that always calls
   event.preventDefault() for anything carrying data-action (see wireEvents
   below) — including these two real <a href> elements. Their native
   navigation is replaced here with the equivalent explicit action so the
   share links still work exactly like tapping a normal WhatsApp/mailto link. */
function openWhatsAppShare(node) {
  window.open(node.href, '_blank', 'noopener,noreferrer');
}

function openEmailShare(node) {
  window.location.href = node.href;
}

/* ==========================================================================
   Expand / collapse
   ========================================================================== */

function toggleCard(trigger) {
  playSound('click');
  const card = trigger.closest('.card');
  if (!card) return;
  const revealed = card.classList.toggle('revealed');
  trigger.setAttribute('aria-expanded', revealed ? 'true' : 'false');

  const id = card.dataset.id;
  if (!id) return;
  if (revealed) expandedSet().add(id);
  else expandedSet().delete(id);
}

function toggleAllCards() {
  playSound('click');
  ui.allExpanded = !ui.allExpanded;
  const btn = els.expandAllBtn;

  if (isStudyView()) {
    const set = expandedSet();
    els['quiz-list'].querySelectorAll('.card').forEach((card) => {
      card.classList.toggle('revealed', ui.allExpanded);
      const trigger = card.querySelector('[data-action="toggle-card"]');
      if (trigger) trigger.setAttribute('aria-expanded', ui.allExpanded ? 'true' : 'false');
      if (!card.dataset.id) return;
      if (ui.allExpanded) set.add(card.dataset.id);
      else set.delete(card.dataset.id);
    });
    btn.textContent = ui.allExpanded ? '🔼 Collapse All' : '🔽 Expand All';
  } else {
    /* Bug #15: the original walked the DATA array and indexed elements by
       position, which threw when the rendered list and the data list had
       diverged. We walk the rendered DOM instead. */
    els['mcq-view'].querySelectorAll('.card').forEach((card) => {
      const index = Number(card.dataset.index);
      const item = ui.currentMCQItems[index];
      const options = card.querySelector('.mcq-options');
      const source = card.querySelector('[data-role="source"]');
      if (!options || !item) return;

      if (ui.allExpanded) {
        if (source) source.classList.add('is-visible');
        options.classList.add('answered');
        const correct = options.children[item.correct];
        if (correct) correct.classList.add('correct');
        Array.from(options.children).forEach((b) => { b.disabled = true; });
      } else {
        if (source) source.classList.remove('is-visible');
        options.classList.remove('answered');
        Array.from(options.children).forEach((b) => {
          b.classList.remove('correct', 'wrong');
          b.disabled = false;
        });
      }
    });
    btn.textContent = ui.allExpanded ? '🔼 Hide Answer Key' : '🔽 Show Answer Key';
  }
  btn.setAttribute('aria-pressed', ui.allExpanded ? 'true' : 'false');
}

function toggleShuffle() {
  playSound('click');
  ui.shuffled = !ui.shuffled;
  if (ui.shuffled) reshuffle();
  els.shuffleBtn.setAttribute('aria-pressed', ui.shuffled ? 'true' : 'false');
  els.shuffleBtn.textContent = ui.shuffled ? '↩️ Restore Order' : '🔀 Shuffle';
  stopAudio();
  setPlayerIndex(0);
  refresh();
  toast(ui.shuffled ? 'List shuffled.' : 'Original order restored.');
}

/* ==========================================================================
   Full-screen image viewer
   ========================================================================== */

function openFullScreen(src) {
  const url = safeUrl(src);
  if (!url) return;
  els.fsImage.src = url;
  els.fsImage.alt = 'Full screen view of the selected image';
  openModal(els.fsModal, els.fsModal.querySelector('.fs-close'));
}

function closeFullScreen() {
  closeModal(els.fsModal);
  // Bug #51: release the decoded bitmap instead of keeping it resident.
  els.fsImage.removeAttribute('src');
}

/* ==========================================================================
   Per-card editors (flag 3 / 4 / 5)
   ========================================================================== */

function editorTarget(node) {
  const card = node.closest('.card');
  const item = card ? itemFromCard(card) : null;
  return { card, item };
}

function saveChapter(node) {
  const { item } = editorTarget(node);
  if (!item) return;
  const value = node.value.trim();
  if (value) cloud.chapters[item.id] = value;
  else delete cloud.chapters[item.id];
  persist();
}

function saveDiagramField(node, field) {
  const { item } = editorTarget(node);
  if (!item) return;
  const value = node.value.trim();

  if (field === 'link' && value && !safeUrl(value)) {
    toast('That link is not a valid http(s) address.', 'error');
    return;
  }

  const entry = cloud.diagrams[item.id] || {};
  if (value) entry[field] = value;
  else delete entry[field];

  if (Object.keys(entry).length === 0) delete cloud.diagrams[item.id];
  else cloud.diagrams[item.id] = entry;

  persist();
  if (field === 'link') patchCard(item);
}

function saveUpdateText(node) {
  const { item } = editorTarget(node);
  if (!item) return;
  const entry = cloud.updates[item.id] || {};
  const value = node.value;
  if (value) entry.text = value;
  else delete entry.text;
  if (Object.keys(entry).length === 0) delete cloud.updates[item.id];
  else cloud.updates[item.id] = entry;
  persist();
}

function saveMedia(node, mapName, field) {
  const { item } = editorTarget(node);
  if (!item) return;
  const value = node.value.trim();
  if (value && !safeUrl(value)) { toast('That image link is not a valid http(s) address.', 'error'); return; }

  const map = cloud[mapName];
  const entry = map[item.id] || {};
  if (value) entry[field] = value;
  else delete entry[field];
  if (Object.keys(entry).length === 0) delete map[item.id];
  else map[item.id] = entry;

  persist();
  patchCard(item);
}

function uploadMedia(input, mapName, field) {
  const { item } = editorTarget(input);
  if (!item || !input.files || !input.files[0]) return;
  compressImage(input.files[0], (dataUrl) => {
    const map = cloud[mapName];
    map[item.id] = Object.assign({}, map[item.id], { [field]: dataUrl });
    persist();
    input.value = '';
    patchCard(item);
    toast('Image saved.', 'success');
  });
}

function clearMediaField(node, mapName, field) {
  const { item } = editorTarget(node);
  if (!item) return;
  const map = cloud[mapName];
  if (!map[item.id]) return;
  delete map[item.id][field];
  if (Object.keys(map[item.id]).length === 0) delete map[item.id];
  persist();   // full-document write, so the removal sticks (#5)
  patchCard(item);
}

/* ==========================================================================
   Cloud sync reactions
   ========================================================================== */

let syncShadow = new Map();

function hashFor(id) {
  return JSON.stringify([cloud.flags[id], cloud.chapters[id], cloud.diagrams[id], cloud.updates[id]]);
}

function rebuildShadow() {
  const next = new Map();
  const ids = new Set([
    ...Object.keys(cloud.flags), ...Object.keys(cloud.chapters),
    ...Object.keys(cloud.diagrams), ...Object.keys(cloud.updates)
  ]);
  for (const id of ids) next.set(id, hashFor(id));
  return next;
}

function handleCloudUpdate() {
  saveMirror();

  if (getMode(ui.mode).view() === 'material') {
    // Never yank the note editor out from under the user.
    if (!els.noteModal.classList.contains('is-open')) refresh();
    return;
  }

  const next = rebuildShadow();
  const changed = new Set();
  for (const [id, hash] of next) if (syncShadow.get(id) !== hash) changed.add(id);
  for (const id of syncShadow.keys()) if (!next.has(id)) changed.add(id);
  syncShadow = next;

  if (changed.size === 0) return;

  /* Bug #10: patch only the cards that actually changed. No stopAudio(), no
     full rebuild, no lost scroll position. */
  let needsFilter = false;
  for (const id of changed) {
    const item = ui.visibleItems.find((i) => i.id === id) || recordsById.get(id);
    if (!item) continue;
    if (findCard(id)) patchCard(item);
    else if (ui.filterType !== 'all') needsFilter = true;
  }

  if (needsFilter && !player.playing) refresh({ keepScroll: true });
}

function handleSyncStatus({ state, message }) {
  const node = els.syncStatus;
  if (!node) return;
  node.dataset.state = state;
  const labels = {
    connecting: '⏳ Connecting…',
    synced: '☁️ Synced',
    pending: '⏳ Saving…',
    offline: '📴 Offline',
    error: '⚠️ Sync issue'
  };
  node.textContent = labels[state] || state;
  node.title = message || '';
  if (state === 'error') toast(message, 'error', 5000);
}

/* ==========================================================================
   Event delegation
   ========================================================================== */

const CLICK_ACTIONS = {
  'switch-mode': (node) => switchMode(node.dataset.mode),
  'toggle-sfx': () => toggleSFX(),
  'apply-filter': (node) => applyFilter(node.dataset.type),
  'filter-topic': (node) => filterMixedTopic(node.dataset.topic),
  'toggle-mixed-options': () => toggleMixedModeOptions(),
  'toggle-shuffle': () => toggleShuffle(),
  'toggle-expand-all': () => toggleAllCards(),
  'toggle-card': (node) => toggleCard(node),
  'toggle-menu': (node) => toggleMenu(node),
  'copy-card': (node) => copyCard(node.closest('.card')),
  'set-flag': (node) => setFlag(node.closest('.card'), Number(node.dataset.flag)),
  'check-answer': (node) => checkAnswer(node.closest('.card'), Number(node.dataset.opt)),
  'open-image': (node) => openFullScreen(node.getAttribute('src')),
  'close-fullscreen': () => closeFullScreen(),
  'clear-diagram': (node) => clearMediaField(node, 'diagrams', 'img'),
  'clear-media': (node) => clearMediaField(node, 'updates', 'media'),

  // Share
  'share-app': () => shareApp(),
  'share-copy': () => copyShareLink(),
  'share-whatsapp': (node) => openWhatsAppShare(node),
  'share-email': (node) => openEmailShare(node),
  'close-share-modal': () => closeModal(els.shareModal),

  // Study material
  'create-folder': () => createNewFolder(),
  'open-folder': (node) => openFolder(node.dataset.folder),
  'delete-folder': (node) => deleteFolder(node.dataset.folder),
  'rename-folder': (node) => renameFolder(node.dataset.folder),
  'back-to-folders': () => renderStudyMaterials(),
  'add-note': () => openAddNoteModal(),
  'edit-note': (node) => editNote(Number(node.dataset.index)),
  'delete-note': (node) => deleteNote(Number(node.dataset.index)),
  'save-note': () => saveNoteFromModal(),
  'close-note-modal': () => closeAddNoteModal(),

  // Confirm dialog
  'confirm-ok': () => resolveConfirm(els.confirmInput.classList.contains('is-hidden') ? true : els.confirmInput.value.trim()),
  'confirm-cancel': () => resolveConfirm(false),

  // Player
  'player-toggle': () => toggleAudioPlayer(),
  'player-play': () => togglePlay(),
  'player-stop': () => stopAudio(),
  'player-prev': () => skip(-1),
  'player-next': () => skip(1),
  'player-speed': () => cycleSpeed(),
  'player-jump': () => jumpToNumber(els.jumpInput.value),
  'scroll-top': () => { playSound('click'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
};

const CHANGE_ACTIONS = {
  'book-change': () => handleBookChange(),
  'chapter-change': () => { ui.chapterFilter = els.chapterFilter.value; savePrefs({ lastChapter: ui.chapterFilter }); refresh(); },
  'range-change': () => { ui.rangeValue = els.rangeSelect.value; playSound('click'); stopAudio(); setPlayerIndex(0); refresh(); },
  'save-chapter': (node) => saveChapter(node),
  'save-diagram-link': (node) => saveDiagramField(node, 'link'),
  'save-diagram-comment': (node) => saveDiagramField(node, 'comment'),
  'save-update-text': (node) => saveUpdateText(node),
  'save-update-media': (node) => saveMedia(node, 'updates', 'media'),
  'upload-diagram': (node) => uploadMedia(node, 'diagrams', 'img'),
  'upload-update': (node) => uploadMedia(node, 'updates', 'media'),
  'modal-image': (node) => handleModalImage(node)
};

function applyFilter(type) {
  playSound('click');
  ui.filterType = type;
  document.querySelectorAll('.filter-chip[data-type]').forEach((chip) => {
    const active = chip.dataset.type === type;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  stopAudio();
  setPlayerIndex(0);
  refresh();

  if (type === '3') {
    toast('More Info workspace enabled on these cards.', 'info', 2600);
  }
}

function filterMixedTopic(topic) {
  playSound('click');
  ui.mixedTopic = topic;
  document.querySelectorAll('.topic-chip').forEach((chip) => {
    const active = chip.dataset.topic === topic;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  stopAudio();
  setPlayerIndex(0);
  refresh();
}

function toggleMixedModeOptions() {
  playSound('click');
  ui.mixedOptionsVisible = !ui.mixedOptionsVisible;
  const btn = els.mixedModeToggleBtn;
  btn.textContent = ui.mixedOptionsVisible ? '📝 Text Only' : '👁️ Show Options';
  btn.classList.toggle('primary', ui.mixedOptionsVisible);
  btn.classList.toggle('expand', !ui.mixedOptionsVisible);
  btn.setAttribute('aria-pressed', ui.mixedOptionsVisible ? 'true' : 'false');
  ui.allExpanded = false;
  els.expandAllBtn.textContent = ui.mixedOptionsVisible ? '🔽 Show Answer Key' : '🔽 Expand All';
  stopAudio();
  setPlayerIndex(0);
  refresh();
}

function toggleAudioPlayer() {
  playSound('click');
  const body = els.playerBody;
  const btn = els.playerToggleBtn;
  const open = !body.classList.contains('show');
  body.classList.toggle('show', open);
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  // The drawer now sits flush on top of the pill with no gap (so they read
  // as one shape). Squaring the pill's top corners while it's open removes
  // the small step where a rounded corner would otherwise peek out from
  // under the drawer's square bottom edge.
  els.audioPlayerContainer.classList.toggle('drawer-open', open);
  syncPlayerGap();
}

/* --------------------------------------------------------------------------
   Live-site bug: the audio player is `position: fixed`, and the body only
   ever reserved space for its COLLAPSED height (`--player-height`, a static
   68px guess). Opening the expanded drawer, or the drawer simply rendering
   taller than that guess on some device/font-size, made it float on top of
   whatever card happened to be underneath instead of the page making room.

   Rather than guess a bigger constant, measure the player's real on-screen
   height and publish it as `--live-player-gap`; base.css takes whichever of
   that or the static gap is larger. Re-measured on every toggle, resize,
   orientation change and mode switch, so it tracks reality on any device,
   font size or text length instead of drifting out of sync again.
   -------------------------------------------------------------------------- */
function syncPlayerGap() {
  const container = els.audioPlayerContainer;
  if (!container) return;

  if (container.classList.contains('is-hidden')) {
    document.documentElement.style.setProperty('--live-player-gap', '0px');
    return;
  }

  // getBoundingClientRect() on the fixed container itself would NOT include
  // an absolutely-positioned child (player-body) that extends above it —
  // out-of-flow descendants don't grow their containing block's own box.
  // Measure whichever element is currently the topmost visible edge.
  const topmost = els.playerBody.classList.contains('show') ? els.playerBody : container;
  const rect = topmost.getBoundingClientRect();
  // Clamped: environments with no real layout engine (e.g. the jsdom test
  // suite) report an all-zero rect, which would otherwise publish a bogus
  // gap the size of the whole viewport.
  const gap = Math.min(600, Math.max(0, Math.ceil(window.innerHeight - rect.top)) + 16);
  document.documentElement.style.setProperty('--live-player-gap', `${gap}px`);
}

/* --- The three delegated listeners --------------------------------------- */

function wireEvents() {
  document.addEventListener('click', (event) => {
    const node = event.target.closest('[data-action]');

    if (!node) {
      if (!event.target.closest('.menu-wrapper')) closeAllMenus();
      if (event.target === els.fsModal) closeFullScreen();          // backdrop click
      if (event.target === els.noteModal) closeAddNoteModal();
      if (event.target === els.shareModal) closeModal(els.shareModal);
      return;
    }

    const handler = CLICK_ACTIONS[node.dataset.action];
    if (!handler) return;
    if (node.tagName === 'INPUT' && node.type === 'file') return;   // handled on change
    event.preventDefault();
    handler(node);
  });

  document.addEventListener('change', (event) => {
    const node = event.target.closest('[data-action]');
    if (!node) return;
    const handler = CHANGE_ACTIONS[node.dataset.action];
    if (handler) handler(node);
  });

  /* Bug #44: search used to run the whole filter + DOM rebuild on every
     keystroke. Debounced, and reading `input` rather than `keyup` so paste and
     clear-button events are caught too. */
  let searchTimer = null;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ui.searchTerm = els.searchInput.value;
      setPlayerIndex(0);
      refresh();
    }, 220);
  });

  els.jumpInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); jumpToNumber(els.jumpInput.value); }
  });

  // Keyboard support for the image "buttons" and modals.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const modal = topModal();
      if (modal === els.fsModal) { closeFullScreen(); return; }
      if (modal === els.noteModal) { closeAddNoteModal(); return; }
      if (modal === els.shareModal) { closeModal(els.shareModal); return; }
      if (modal === els.confirmModal) { resolveConfirm(false); return; }
      if (document.querySelector('.menu-dropdown.show')) { closeAllMenus(); return; }
    }
    if (event.key === 'Tab') trapFocus(event);

    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('img[data-action="open-image"]')) {
      event.preventDefault();
      openFullScreen(event.target.getAttribute('src'));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'newFolderInput') {
      event.preventDefault();
      createNewFolder();
    }
  }, true);

  // Prime the audio graph and the speech engine on the first real gesture.
  const prime = () => {
    if (ui.sfxEnabled) initAudio();
    primeVoice();
    document.removeEventListener('pointerdown', prime);
    document.removeEventListener('keydown', prime);
  };
  document.addEventListener('pointerdown', prime);
  document.addEventListener('keydown', prime);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !player.playing) releaseAudio();
  });

  // Re-measure the reserved player space on anything that can change it:
  // rotating the phone, the on-screen keyboard resizing the viewport, a
  // font-size / zoom change, or text wrapping differently at a new width.
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(syncPlayerGap);
  });
  window.addEventListener('orientationchange', () => requestAnimationFrame(syncPlayerGap));

  on('cloud-updated', handleCloudUpdate);
  on('sync-status', handleSyncStatus);
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function boot() {
  cacheEls();
  loadPrefs();

  // SFX button reflects the stored preference.
  if (els['btn-sfx']) {
    els['btn-sfx'].classList.toggle('muted', !ui.sfxEnabled);
    els['btn-sfx'].textContent = ui.sfxEnabled ? '🔊' : '🔇';
    els['btn-sfx'].setAttribute('aria-pressed', ui.sfxEnabled ? 'true' : 'false');
  }

  wireEvents();
  initVoices();
  initSpeed();

  emptyState(els['quiz-list'], 'Loading question bank…');

  try {
    await loadData();
  } catch (err) {
    console.error(err);
    emptyState(els['quiz-list'], 'The question bank could not be loaded. Check your connection and reload.');
    return;
  }

  // Offline mirror first, so content is on screen before Firestore answers.
  loadMirror();
  syncShadow = rebuildShadow();

  // Restore the last mode the user was in (local-only preference).
  switchMode(MODES[prefs.lastMode] ? prefs.lastMode : 'flashcard');
  restoreLastFilters();

  initSync();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
    });
  }
}

/* The module is loaded with `defer` semantics, so the DOM is already parsed;
   the readyState check keeps it safe if that ever changes. */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { switchMode as _switchMode };
