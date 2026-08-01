/* ===========================================================================
   modes.js — one mode registry.
   Bugs #14 / #26 of the original: the same seven-way `if/else` ladder was
   written out three times (populateRangeDropdown, applyMasterFilter,
   applyRangeFilter) and every new mode needed three synchronised edits.
   Everything about a mode now lives in exactly one place.
   =========================================================================== */

import { datasets, ui } from './state.js';

/**
 * view:      'study' renders expandable Q/A cards into #quiz-list,
 *            'mcq'   renders option cards into #mcq-view,
 *            'material' renders the Study Material workspace.
 * Mixed Topic switches between 'study' and 'mcq' at runtime, so its `view`
 * is a function rather than a constant.
 */
export const MODES = {
  flashcard: {
    id: 'flashcard',
    label: 'Book Topics QA',
    button: 'btn-flash',
    view: () => 'study',
    data: () => datasets.flashcard,
    controls: { search: true, flagChips: true, bookChapter: true, range: true, expand: true, shuffle: true, mixed: false, scoreboard: false, player: true }
  },
  'mcq-study': {
    id: 'mcq-study',
    label: 'Study QA',
    button: 'btn-mcq-study',
    view: () => 'study',
    data: () => datasets['mcq-study'],
    controls: { search: true, flagChips: true, bookChapter: true, range: true, expand: true, shuffle: true, mixed: false, scoreboard: false, player: true }
  },
  'mixed-topic': {
    id: 'mixed-topic',
    label: 'Mixed Topic',
    button: 'btn-mixed',
    view: () => (ui.mixedOptionsVisible ? 'mcq' : 'study'),
    data: () => datasets['mixed-topic'],
    controls: { search: true, flagChips: true, bookChapter: true, range: true, expand: true, shuffle: true, mixed: true, scoreboard: false, player: true }
  },
  mcq: {
    id: 'mcq',
    label: 'MCQ',
    button: 'btn-mcq',
    view: () => 'mcq',
    data: () => datasets.mcq,
    // The original hid search + flag chips in MCQ mode; kept as-is.
    controls: { search: false, flagChips: false, bookChapter: true, range: true, expand: true, shuffle: true, mixed: false, scoreboard: true, player: true }
  },
  'latest-important': {
    id: 'latest-important',
    label: 'Latest Important',
    button: 'btn-latest',
    view: () => 'study',
    data: () => datasets['latest-important'],
    controls: { search: true, flagChips: true, bookChapter: true, range: true, expand: true, shuffle: true, mixed: false, scoreboard: false, player: true }
  },
  'key-tables': {
    id: 'key-tables',
    label: 'Key Tables',
    button: 'btn-tables',
    view: () => 'study',
    data: () => datasets['key-tables'],
    controls: { search: true, flagChips: true, bookChapter: true, range: true, expand: true, shuffle: true, mixed: false, scoreboard: false, player: true }
  },
  material: {
    id: 'material',
    label: 'Study Material',
    button: 'btn-material',
    view: () => 'material',
    data: () => [],
    controls: { search: false, flagChips: false, bookChapter: false, range: false, expand: false, shuffle: false, mixed: false, scoreboard: false, player: false }
  }
};

export const MODE_IDS = Object.keys(MODES);

/* Bug: the original's `else` branch silently rendered MCQ for any unknown
   mode string. Unknown modes now fall back to the documented default. */
export function getMode(id) {
  return MODES[id] || MODES.flashcard;
}

export function currentMode() {
  return getMode(ui.mode);
}

export function currentView() {
  return currentMode().view();
}

export function baseData(modeId = ui.mode) {
  return getMode(modeId).data();
}

/** Modes whose cards use the expandable study-card layout. */
export function isStudyView(modeId = ui.mode) {
  return getMode(modeId).view() === 'study';
}
