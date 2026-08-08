/* ===========================================================================
   render.js — card construction + the single chunked renderer.

   Every piece of user- or data-authored text reaches the DOM through
   `textContent` / `setAttribute`, never through an interpolated `innerHTML`
   string. That closes the stored-XSS hole (bug #1) and the "folder named
   Mike's Notes breaks the card" hole (bug #2) at the same time, because there
   are no inline handlers left to break: interaction is delegated via
   `data-action` attributes (see app.js).
   =========================================================================== */

import { ui, flagsFor, chapterFor, diagramFor, updateFor, safeUrl, expandedSet } from './state.js';
import { isStudyView } from './modes.js';

const CHUNK_SIZE = 50;

export const els = {};

export function cacheEls() {
  const ids = [
    'quiz-list', 'mcq-view', 'exam-scoreboard', 'scoreValue', 'scoreProgress', 'levelBadge',
    'searchInput', 'bookFilter', 'chapterFilter', 'rangeSelect', 'shuffleBtn', 'expandAllBtn',
    'flashcard-controls', 'mixed-topic-controls', 'mixedModeToggleBtn', 'flagChips',
    'audioPlayerContainer', 'playerBody', 'playerToggleBtn', 'playPauseBtn', 'speedBtn',
    'statusDisplay', 'jumpInput', 'btn-sfx', 'fsModal', 'fsImage', 'noteModal', 'modalTitle',
    'modalNoteText', 'modalNoteLink', 'modalNoteImgUrl', 'modalNoteImg', 'modalImgPreview',
    'toastHost', 'confirmModal', 'confirmText', 'confirmInput', 'confirmOk', 'confirmCancel',
    'syncStatus'
  ];
  for (const id of ids) els[id] = document.getElementById(id);
  return els;
}

/* --------------------------------------------------------------------------
   Small DOM helpers
   -------------------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function attrs(node, map) {
  for (const [k, v] of Object.entries(map)) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  return node;
}

export function emptyState(container, message) {
  container.textContent = '';
  container.appendChild(el('div', 'empty-state', message));
}

/* --------------------------------------------------------------------------
   Toasts and dialogs — replace alert() / confirm() / prompt() (bug #75)
   -------------------------------------------------------------------------- */

export function toast(message, kind = 'info', ms = 3200) {
  const host = els.toastHost;
  if (!host) return;
  const node = el('div', `toast toast--${kind}`, message);
  attrs(node, { role: kind === 'error' ? 'alert' : 'status' });
  host.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

let confirmResolver = null;

export function confirmDialog({ message, okLabel = 'Confirm', danger = false, prompt = null }) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    els.confirmText.textContent = message;
    els.confirmOk.textContent = okLabel;
    els.confirmOk.classList.toggle('danger', !!danger);
    els.confirmOk.classList.toggle('primary', !danger);
    if (prompt !== null) {
      els.confirmInput.classList.remove('is-hidden');
      els.confirmInput.value = prompt;
    } else {
      els.confirmInput.classList.add('is-hidden');
      els.confirmInput.value = '';
    }
    openModal(els.confirmModal, prompt !== null ? els.confirmInput : els.confirmOk);
  });
}

export function resolveConfirm(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  closeModal(els.confirmModal);
  if (resolve) resolve(value);
}

/* --------------------------------------------------------------------------
   Modal plumbing: focus trap, Escape, focus restore (bug #70)
   -------------------------------------------------------------------------- */

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input:not([type="hidden"]), select, [tabindex]:not([tabindex="-1"])';
let lastFocused = null;
const modalStack = [];

export function openModal(modal, focusTarget) {
  if (!modal) return;
  lastFocused = document.activeElement;
  modal.classList.add('is-open');
  modal.removeAttribute('aria-hidden');
  modalStack.push(modal);
  const target = focusTarget || modal.querySelector(FOCUSABLE);
  if (target) setTimeout(() => target.focus(), 30);
}

export function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  const idx = modalStack.indexOf(modal);
  if (idx > -1) modalStack.splice(idx, 1);
  if (modalStack.length === 0 && lastFocused && document.contains(lastFocused)) {
    lastFocused.focus();
    lastFocused = null;
  }
}

export function topModal() {
  return modalStack[modalStack.length - 1] || null;
}

export function trapFocus(event) {
  const modal = topModal();
  if (!modal || event.key !== 'Tab') return;
  const nodes = Array.from(modal.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* --------------------------------------------------------------------------
   THE chunked renderer.
   Bug #8: the original had four call sites that cleared a container and
   started a new rAF chain WITHOUT cancelling the in-flight one, so two chains
   appended into the same container. There is now exactly one entry point and
   it always cancels first.
   -------------------------------------------------------------------------- */

let renderTask = null;

export function cancelRender() {
  if (renderTask !== null) {
    cancelAnimationFrame(renderTask);
    renderTask = null;
  }
}

export function startChunkedRender(container, data, buildCard, onDone) {
  cancelRender();
  container.textContent = '';

  if (!data || data.length === 0) {
    emptyState(container, 'No questions match the current filters.');
    if (onDone) onDone();
    return;
  }

  const renderChunk = (start) => {
    const end = Math.min(start + CHUNK_SIZE, data.length);
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const node = buildCard(data[i], i);
      // Bug #47: only the first painted chunk animates, not all 1001 cards.
      if (start === 0) node.classList.add('card--enter');
      fragment.appendChild(node);
    }
    container.appendChild(fragment);

    if (end < data.length) {
      renderTask = requestAnimationFrame(() => renderChunk(end));
    } else {
      renderTask = null;
      if (onDone) onDone();
    }
  };

  renderChunk(0);
}

/* --------------------------------------------------------------------------
   Badges
   -------------------------------------------------------------------------- */

const FLAG_META = {
  1: { cls: 'badge-1', label: '🚩 Revise',     menu: '🚩 Flag 1 (Revise)' },
  2: { cls: 'badge-2', label: '⚠️ Fix Info',   menu: '⚠️ Flag 2 (Misinfo)' },
  3: { cls: 'badge-3', label: 'ℹ️ More Info',  menu: 'ℹ️ Flag 3 (More Info)' },
  4: { cls: 'badge-4', label: '📖 Chapter',    menu: '📖 Flag 4 (Chapter)' },
  5: { cls: 'badge-5', label: '📊 Diagram',    menu: '📊 Flag 5 (Diagram)' },
  6: { cls: 'badge-6', label: '🔗 Similar Qs', menu: '🔗 Flag 6 (Similar)' }
};

function buildBadges(flags) {
  const wrap = el('div', 'badge-container');
  for (const type of [1, 2, 3, 4, 5, 6]) {
    if (!flags.includes(type)) continue;
    wrap.appendChild(el('div', `flag-badge ${FLAG_META[type].cls}`, FLAG_META[type].label));
  }
  return wrap;
}

/** Human-readable name for a flag type, for toasts/confirmations. */
export function flagLabel(type) {
  return FLAG_META[type] ? FLAG_META[type].label : null;
}

/* --------------------------------------------------------------------------
   Card menu
   -------------------------------------------------------------------------- */

function buildMenu(item, flags) {
  const wrapper = el('div', 'menu-wrapper');

  const btn = el('button', 'menu-btn', '⋮');
  attrs(btn, {
    type: 'button',
    'data-action': 'toggle-menu',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    'aria-label': `Options for question ${item.displayId}`
  });

  const menu = el('div', 'menu-dropdown');
  attrs(menu, { role: 'menu', 'data-menu': item.id });

  const copy = el('button', 'menu-item', '📋 Copy Content');
  attrs(copy, { type: 'button', role: 'menuitem', 'data-action': 'copy-card' });
  menu.appendChild(copy);

  for (const type of [1, 2, 3, 4, 5, 6]) {
    const active = flags.includes(type);
    const mi = el('button', `menu-item${active ? ' active-flag' : ''}`, FLAG_META[type].menu);
    attrs(mi, {
      type: 'button',
      role: 'menuitemcheckbox',
      'aria-checked': active ? 'true' : 'false',
      'data-action': 'set-flag',
      'data-flag': type
    });
    menu.appendChild(mi);
  }

  if (flags.length > 0) {
    const clear = el('button', 'menu-item menu-item--danger', '❌ Clear All Flags');
    attrs(clear, { type: 'button', role: 'menuitem', 'data-action': 'set-flag', 'data-flag': '0' });
    menu.appendChild(clear);
  }

  wrapper.append(btn, menu);
  return wrapper;
}

/* --------------------------------------------------------------------------
   Flag-4 / flag-5 / flag-3 editors
   -------------------------------------------------------------------------- */

function labelledInput({ className, placeholder, value, action, label }) {
  const input = el('input', className);
  attrs(input, {
    type: 'text',
    placeholder,
    'data-action': action,
    'aria-label': label
  });
  input.value = value || '';
  return input;
}

function buildImageBlock(src, clearAction, altText) {
  const frag = document.createDocumentFragment();
  const url = safeUrl(src);
  if (!url) return frag;

  const img = el('img', 'media-preview');
  attrs(img, {
    src: url,
    alt: altText,
    loading: 'lazy',
    'data-action': 'open-image',
    tabindex: '0',
    role: 'button'
  });
  frag.appendChild(img);

  if (clearAction) {
    const btn = el('button', 'link-btn link-btn--danger', '❌ Remove image');
    attrs(btn, { type: 'button', 'data-action': clearAction });
    frag.appendChild(btn);
  }
  return frag;
}

function buildChapterEditor(item) {
  const box = el('div', 'extra-field-box extra-field-box--chapter');
  const label = el('label', 'field-label', '📖 Chapter Name');
  const inputId = `chapter-${item.id}`;
  label.setAttribute('for', inputId);

  const input = labelledInput({
    className: 'chapter-input',
    placeholder: 'Type Book/Chapter Name...',
    value: chapterFor(item),
    action: 'save-chapter',
    label: 'Chapter name'
  });
  input.id = inputId;

  box.append(label, input);
  return box;
}

function buildDiagramEditor(item) {
  const data = diagramFor(item);
  const box = el('div', 'extra-field-box extra-field-box--diagram');
  box.appendChild(el('div', 'field-label', '📊 Diagram & Notes'));

  const upload = el('label', 'upload-btn-wrapper');
  upload.append(document.createTextNode('📤 Upload Diagram'));
  const file = el('input');
  attrs(file, { type: 'file', accept: 'image/*', 'data-action': 'upload-diagram', 'aria-label': 'Upload a diagram image' });
  upload.appendChild(file);
  box.appendChild(upload);

  const link = labelledInput({
    className: 'material-input stacked-input',
    placeholder: 'Paste Web Link for Question...',
    value: data.link,
    action: 'save-diagram-link',
    label: 'Related web link'
  });
  box.appendChild(link);

  const safeLink = safeUrl(data.link);
  if (safeLink) {
    const row = el('div', 'stacked-input');
    const a = el('a', 'note-link', '🔗 Open Related Web Link');
    attrs(a, { href: safeLink, target: '_blank', rel: 'noopener noreferrer' });
    row.appendChild(a);
    box.appendChild(row);
  }

  box.appendChild(buildImageBlock(data.img, 'clear-diagram', `Diagram for question ${item.displayId}`));

  const comment = el('textarea', 'diagram-comment');
  attrs(comment, {
    placeholder: 'Add comments about this diagram...',
    'data-action': 'save-diagram-comment',
    'aria-label': 'Diagram comment'
  });
  comment.value = data.comment || '';
  box.appendChild(comment);

  return box;
}

/* The "More Info" workspace (bug #22). In the original this markup was only
   produced by `renderUpdatesList`, which nothing ever called — the feature was
   unreachable. It is now the destination of the ℹ️ More Info filter chip:
   select that chip and every flag-3 card gains its workspace editor. */
function buildUpdateWorkspace(item) {
  const data = updateFor(item);
  const box = el('div', 'update-subspace');
  box.appendChild(el('div', 'update-label', '📝 Workspace'));

  const editor = el('textarea', 'update-editor');
  attrs(editor, {
    placeholder: 'Type summary or paste video links...',
    'data-action': 'save-update-text',
    'aria-label': `Workspace notes for question ${item.displayId}`
  });
  editor.value = data.text || '';
  box.appendChild(editor);

  const row = el('div', 'upload-row');
  const link = labelledInput({
    className: 'material-input',
    placeholder: '🔗 Paste Image Link',
    value: '',
    action: 'save-update-media',
    label: 'Image link'
  });
  row.appendChild(link);

  const upload = el('label', 'upload-btn-wrapper');
  upload.append(document.createTextNode('📷 Upload Photo'));
  const file = el('input');
  attrs(file, { type: 'file', accept: 'image/*', 'data-action': 'upload-update', 'aria-label': 'Upload a workspace photo' });
  upload.appendChild(file);
  row.appendChild(upload);
  box.appendChild(row);

  const media = el('div', 'update-media');
  media.appendChild(buildImageBlock(data.media, 'clear-media', `Workspace image for question ${item.displayId}`));
  box.appendChild(media);

  return box;
}

/* --------------------------------------------------------------------------
   Study card (Book Topics / Study QA / Latest Important / Key Tables /
   Mixed Topic in text mode)
   -------------------------------------------------------------------------- */

/* Bug #40: `item.a.split('[')` dropped everything after a SECOND '['. We
   capture the trailing [Source: ...] with a regex instead. */
function splitAnswer(text) {
  const raw = text == null ? '' : String(text);
  const match = raw.match(/\[[^[\]]*\]\s*$/);
  if (!match) return { answer: raw.trim(), citation: '' };
  return { answer: raw.slice(0, match.index).trim(), citation: match[0].trim() };
}

export function buildStudyCard(item, index) {
  const flags = flagsFor(item);
  const showWorkspace = ui.filterType === '3' && flags.includes(3);
  const revealed = ui.allExpanded || showWorkspace || expandedSet().has(item.id);

  const card = el('div', `card${revealed ? ' revealed' : ''}`);
  attrs(card, { 'data-id': item.id, 'data-index': index, 'data-card': 'study' });

  /* Header is a real <button> so it is focusable and keyboard-operable
     (bug #70). The menu lives outside it — nested buttons are invalid. */
  const header = el('div', 'card-header');

  const trigger = el('button', 'card-header--button');
  attrs(trigger, {
    type: 'button',
    'data-action': 'toggle-card',
    'aria-expanded': revealed ? 'true' : 'false',
    'aria-controls': `answer-${item.id}`
  });

  const content = el('div', 'q-content');
  content.appendChild(el('div', 'q-num', item.displayId));
  const qHeading = el('h3', 'q-text', item.q);
  content.appendChild(qHeading);
  const hint = el('span', 'reveal-hint', '▼');
  attrs(hint, { 'aria-hidden': 'true' });
  content.appendChild(hint);
  trigger.appendChild(content);

  header.appendChild(trigger);
  header.appendChild(buildMenu(item, flags));
  card.appendChild(header);

  card.appendChild(buildBadges(flags));

  const answerBox = el('div', `answer-box${showWorkspace ? ' is-open' : ''}`);
  answerBox.id = `answer-${item.id}`;
  attrs(answerBox, { role: 'region', 'aria-label': `Answer to question ${item.displayId}` });

  const ansContent = el('div', 'ans-content');
  const { answer, citation } = splitAnswer(item.a);
  ansContent.appendChild(el('div', 'ans-text', answer));
  if (citation) ansContent.appendChild(el('span', 'citation', citation));

  if (flags.includes(4)) ansContent.appendChild(buildChapterEditor(item));
  if (flags.includes(5)) ansContent.appendChild(buildDiagramEditor(item));
  if (showWorkspace) ansContent.appendChild(buildUpdateWorkspace(item));

  answerBox.appendChild(ansContent);
  card.appendChild(answerBox);

  return card;
}

/* --------------------------------------------------------------------------
   MCQ card
   -------------------------------------------------------------------------- */

export function buildMCQCard(item, index) {
  const card = el('div', 'card');
  attrs(card, { 'data-id': item.id, 'data-index': index, 'data-card': 'mcq' });

  const header = el('div', 'card-header card-header--static');
  const content = el('div', 'q-content');
  content.appendChild(el('div', 'q-num', item.displayId));
  content.appendChild(el('h3', 'q-text', item.q));
  header.appendChild(content);
  card.appendChild(header);

  const options = el('div', 'mcq-options');
  attrs(options, { role: 'group', 'aria-label': `Answer options for question ${item.displayId}` });

  item.options.forEach((opt, optIdx) => {
    const btn = el('button', 'option-btn');
    attrs(btn, { type: 'button', 'data-action': 'check-answer', 'data-opt': optIdx });
    btn.appendChild(el('span', 'option-letter', `${String.fromCharCode(65 + optIdx)}.`));
    btn.appendChild(el('span', 'option-text', opt));
    btn.appendChild(el('span', 'option-mark'));   // filled in by CSS on correct/wrong
    options.appendChild(btn);
  });
  card.appendChild(options);

  const source = el('div', 'mcq-source');
  attrs(source, { 'data-role': 'source' });
  source.appendChild(el('span', 'mcq-answer-label', 'Correct Answer: '));
  source.appendChild(document.createTextNode(item.options[item.correct]));
  source.appendChild(document.createElement('br'));
  source.appendChild(el('span', null, `Source: ${item.source || 'n/a'}`));
  card.appendChild(source);

  return card;
}

/* --------------------------------------------------------------------------
   In-place card patching.
   Bug #11: toggling one flag used to re-run the whole filter + render
   pipeline for up to 1001 items. Bug #10: every Firestore snapshot did the
   same and killed TTS. Both now patch just the affected card.
   -------------------------------------------------------------------------- */

export function findCard(id) {
  const selector = `[data-id="${CSS.escape(id)}"]`;
  return els['quiz-list'].querySelector(selector) || els['mcq-view'].querySelector(selector);
}

export function patchCard(item) {
  const card = findCard(item.id);
  if (!card || card.dataset.card !== 'study') return false;

  // Never clobber a field the user is currently typing into (note/link/image
  // inputs in the inline editors). A focused *button* — e.g. the flag option
  // that was just clicked in the card's menu — must NOT block the patch, or
  // the new flag badge silently doesn't appear until the next full refresh.
  const active = document.activeElement;
  const isEditingField = active && card.contains(active)
    && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (isEditingField) return false;

  const wasRevealed = card.classList.contains('revealed');
  const index = Number(card.dataset.index);
  const fresh = buildStudyCard(item, index);
  if (wasRevealed) {
    fresh.classList.add('revealed');
    const trigger = fresh.querySelector('[data-action="toggle-card"]');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  }
  if (card.classList.contains('active-reading')) fresh.classList.add('active-reading');
  card.replaceWith(fresh);
  return true;
}

/* --------------------------------------------------------------------------
   Highlighting during TTS.
   Bug #45: the original ran querySelectorAll('.card') over ~1,500 nodes for
   every spoken card. We remember the last highlighted element instead.
   -------------------------------------------------------------------------- */

let highlighted = null;

export function clearHighlight() {
  if (highlighted) {
    highlighted.classList.remove('active-reading');
    highlighted = null;
  }
}

export function highlightIndex(index) {
  clearHighlight();
  const container = isStudyView() ? els['quiz-list'] : els['mcq-view'];
  const card = container.children[index];
  if (!card || !card.classList.contains('card')) return;

  card.classList.add('active-reading');
  highlighted = card;
  card.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'center'
  });

  /* Bug #298 in the audit (19209): auto-revealed cards used to collapse on the
     next re-render because they were never recorded as expanded. */
  if (isStudyView()) {
    card.classList.add('revealed');
    const trigger = card.querySelector('[data-action="toggle-card"]');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    if (card.dataset.id) expandedSet().add(card.dataset.id);
  }
}
