/* ===========================================================================
   filters.js — ONE filter pipeline.
   Bugs #13 / #14: the original had `applyMasterFilter` (ignored the range
   dropdown) and `applyRangeFilter` (ignored the flag chip and the search box)
   silently discarding each other's state while both controls still looked
   active. Here every filter is a stage in a single ordered pipeline, so all
   six narrow the list together.
   Bug #9: the pipeline always starts from a COPY, so shuffling or any later
   in-place operation can never mutate the source dataset.
   =========================================================================== */

import { ui, flagsFor } from './state.js';
import { baseData, getMode } from './modes.js';
import { parseSource } from './parse-source.js';

function byMixedTopic(list) {
  if (ui.mode !== 'mixed-topic' || ui.mixedTopic === 'all') return list;
  return list.filter((item) => item.topic === ui.mixedTopic);
}

function byBookChapter(list) {
  if (ui.bookFilter === 'all') return list;
  return list.filter((item) =>
    parseSource(item).some(({ book, chapter }) => {
      if (book !== ui.bookFilter) return false;
      if (ui.chapterFilter !== 'all' && chapter !== ui.chapterFilter) return false;
      return true;
    })
  );
}

function byFlag(list) {
  if (ui.filterType === 'all') return list;
  const wanted = Number(ui.filterType);
  return list.filter((item) => flagsFor(item).includes(wanted));
}

function bySearch(list) {
  const term = ui.searchTerm.trim().toLowerCase();
  if (!term) return list;
  return list.filter((item) => {
    if (item.q && item.q.toLowerCase().includes(term)) return true;
    if (item.a && item.a.toLowerCase().includes(term)) return true;
    // Improvement over the original, which searched only q and a.
    if (item.source && item.source.toLowerCase().includes(term)) return true;
    if (Array.isArray(item.options) && item.options.some((o) => o.toLowerCase().includes(term))) return true;
    return false;
  });
}

/* The range is a slice of the FULL dataset (matching the dropdown labels,
   which are generated from dataset length), applied before the narrowing
   filters so "101 - 200" always means questions 101-200 of the book. */
function byRange(list) {
  if (!ui.rangeValue || ui.rangeValue === 'all') return list;
  const [start, end] = ui.rangeValue.split('-').map(Number);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return list;
  const allowed = new Set(baseData().slice(start, end).map((i) => i.id));
  return list.filter((item) => allowed.has(item.id));
}

/** Fisher-Yates on a copy — never on the source array (bug #9). */
export function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* Preserved across re-filters so the shuffled order is stable until the user
   toggles shuffle off or the underlying list changes. */
let shuffleOrder = null;

export function resetShuffle() {
  shuffleOrder = null;
  ui.shuffled = false;
}

export function reshuffle() {
  shuffleOrder = null; // force a fresh permutation on the next run
}

function applyShuffle(list) {
  if (!ui.shuffled) return list;
  if (!shuffleOrder || shuffleOrder.size !== list.length || list.some((i) => !shuffleOrder.has(i.id))) {
    const permuted = shuffle(list);
    shuffleOrder = new Map(permuted.map((item, idx) => [item.id, idx]));
    return permuted;
  }
  return list.slice().sort((a, b) => shuffleOrder.get(a.id) - shuffleOrder.get(b.id));
}

/**
 * Run the full pipeline for the current UI state.
 * @returns {Array} a fresh array; the caller may reorder it freely.
 */
export function computeList() {
  const mode = getMode(ui.mode);
  if (mode.view() === 'material') return [];

  let list = baseData().slice();   // copy first — bug #9
  list = byRange(list);
  list = byMixedTopic(list);
  list = byBookChapter(list);
  list = byFlag(list);
  list = bySearch(list);
  list = applyShuffle(list);
  return list;
}

/** Range dropdown options for the active mode. */
export function rangeOptions() {
  const data = baseData();
  const opts = [];
  const batch = 100;
  for (let i = 0; i < data.length; i += batch) {
    const end = Math.min(i + batch, data.length);
    opts.push({
      value: `${i}-${end}`,
      label: ui.mode === 'mixed-topic' ? `${i + 1} - ${end}` : `${i + 1} - ${end} Questions`
    });
  }
  return opts;
}
