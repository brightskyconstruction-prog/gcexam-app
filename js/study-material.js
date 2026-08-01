/* ===========================================================================
   study-material.js — folders, notes, the note modal and image compression.

   Every folder name and note body is inserted with textContent and every
   action goes through a data-action attribute, so a folder called
   "Mike's Notes" behaves exactly like any other (bug #2), and note text can
   never inject markup into another group member's session (bug #1).
   =========================================================================== */

import { cloud, ui, safeUrl, saveMirror } from './state.js';
import { els, toast, confirmDialog, openModal, closeModal } from './render.js';
import { playSound } from './audio.js';
import { saveToCloud } from './firebase-sync.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function persist() {
  saveMirror();
  saveToCloud();
}

/* --------------------------------------------------------------------------
   Folder grid
   -------------------------------------------------------------------------- */

export function renderStudyMaterials() {
  ui.currentFolder = null;
  const container = els['quiz-list'];
  container.textContent = '';

  const view = el('div', 'material-view');
  const heading = el('h2', 'material-title', 'Study Material Workspace');
  view.appendChild(heading);

  const row = el('div', 'material-newrow');
  const input = el('input', 'material-input');
  input.id = 'newFolderInput';
  input.type = 'text';
  input.placeholder = 'New Folder Name...';
  input.setAttribute('aria-label', 'New folder name');
  const create = el('button', 'btn primary', '+ Create');
  create.type = 'button';
  create.dataset.action = 'create-folder';
  row.append(input, create);
  view.appendChild(row);

  const grid = el('div', 'folder-grid');
  const names = Object.keys(cloud.studyMaterial);

  if (names.length === 0) {
    view.appendChild(grid);
    const empty = el('div', 'empty-state', 'No folders yet. Create one above to start collecting notes.');
    view.appendChild(empty);
  } else {
    for (const name of names) {
      const notes = Array.isArray(cloud.studyMaterial[name]) ? cloud.studyMaterial[name] : [];

      const card = el('button', 'folder-card');
      card.type = 'button';
      card.dataset.action = 'open-folder';
      card.dataset.folder = name;
      card.setAttribute('aria-label', `Open folder ${name}, ${notes.length} notes`);

      const icon = el('div', 'folder-icon', '📁');
      icon.setAttribute('aria-hidden', 'true');
      card.append(icon, el('div', 'folder-name', name), el('div', 'folder-count', `${notes.length} Notes`));

      const actions = el('div', 'folder-actions');
      const edit = el('button', 'folder-action-btn folder-edit', '✏️');
      edit.type = 'button';
      edit.dataset.action = 'rename-folder';
      edit.dataset.folder = name;
      edit.setAttribute('aria-label', `Rename folder ${name}`);
      const del = el('button', 'folder-action-btn folder-delete', '🗑️');
      del.type = 'button';
      del.dataset.action = 'delete-folder';
      del.dataset.folder = name;
      del.setAttribute('aria-label', `Delete folder ${name}`);
      actions.append(edit, del);

      const wrapper = el('div', 'folder-slot');
      wrapper.append(card, actions);
      grid.appendChild(wrapper);
    }
    view.appendChild(grid);
  }

  container.appendChild(view);
}

export function createNewFolder() {
  playSound('click');
  const input = document.getElementById('newFolderInput');
  const name = input ? input.value.trim() : '';
  if (!name) { toast('Enter a folder name first.', 'error'); return; }
  if (cloud.studyMaterial[name]) { toast('A folder with that name already exists.', 'error'); return; }

  cloud.studyMaterial[name] = [];
  persist();
  renderStudyMaterials();
  toast(`Folder "${name}" created.`, 'success');
}

export async function deleteFolder(name) {
  const ok = await confirmDialog({
    message: `Delete the folder "${name}" and all of its notes? This cannot be undone.`,
    okLabel: 'Delete folder',
    danger: true
  });
  if (!ok) return;

  delete cloud.studyMaterial[name];
  persist();  // full-document write, so the deletion actually reaches Firestore (#5)
  if (ui.currentFolder === name) ui.currentFolder = null;
  renderStudyMaterials();
  toast(`Folder "${name}" deleted.`);
}

export async function renameFolder(oldName) {
  const newName = await confirmDialog({
    message: `Rename the folder "${oldName}" to:`,
    okLabel: 'Rename',
    prompt: oldName
  });
  if (!newName || newName === oldName) return;
  if (cloud.studyMaterial[newName]) { toast('A folder with that name already exists.', 'error'); return; }

  /* Bug #37: copy-then-delete moved the folder to the end of the grid. We
     rebuild the map in place so the position is preserved. */
  const rebuilt = {};
  for (const [key, value] of Object.entries(cloud.studyMaterial)) {
    rebuilt[key === oldName ? newName : key] = value;
  }
  cloud.studyMaterial = rebuilt;
  if (ui.currentFolder === oldName) ui.currentFolder = newName;

  persist();
  if (ui.currentFolder === newName) renderFolderView(newName);
  else renderStudyMaterials();
  toast('Folder renamed.', 'success');
}

export function openFolder(name) {
  playSound('click');
  ui.currentFolder = name;
  renderFolderView(name);
}

/* --------------------------------------------------------------------------
   Folder (note list) view
   -------------------------------------------------------------------------- */

export function renderFolderView(name) {
  const container = els['quiz-list'];
  const notes = Array.isArray(cloud.studyMaterial[name]) ? cloud.studyMaterial[name] : [];

  container.textContent = '';
  const view = el('div', 'material-view');

  const back = el('button', 'back-btn', '← Back to Folders');
  back.type = 'button';
  back.dataset.action = 'back-to-folders';
  view.appendChild(back);

  view.appendChild(el('h2', 'material-title material-title--folder', `📂 ${name}`));

  if (notes.length === 0) {
    view.appendChild(el('div', 'empty-state', 'This folder is empty. Tap + to add your first note.'));
  }

  notes.forEach((note, idx) => {
    const card = el('div', 'note-card');

    const header = el('div', 'note-header');
    header.appendChild(el('span', 'note-num', `#${idx + 1}`));

    const actions = el('div');
    const edit = el('button', 'link-btn', '✏️ Edit');
    edit.type = 'button';
    edit.dataset.action = 'edit-note';
    edit.dataset.index = String(idx);
    edit.setAttribute('aria-label', `Edit note ${idx + 1}`);
    const del = el('button', 'link-btn link-btn--danger', '🗑️');
    del.type = 'button';
    del.dataset.action = 'delete-note';
    del.dataset.index = String(idx);
    del.setAttribute('aria-label', `Delete note ${idx + 1}`);
    actions.append(edit, del);
    header.appendChild(actions);
    card.appendChild(header);

    card.appendChild(el('div', 'note-content', note.text || ''));

    const imgSrc = safeUrl(note.img);
    if (imgSrc) {
      const img = el('img', 'media-preview');
      img.src = imgSrc;
      img.alt = `Image attached to note ${idx + 1}`;
      img.loading = 'lazy';
      img.dataset.action = 'open-image';
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      card.appendChild(img);
    }

    // Bug #1: `javascript:` hrefs are rejected by safeUrl.
    const linkSrc = safeUrl(note.link);
    if (linkSrc) {
      const a = el('a', 'note-link', '🔗 Open Resource');
      a.href = linkSrc;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      card.appendChild(a);
    }

    view.appendChild(card);
  });

  container.appendChild(view);

  const fab = el('button', 'fab-btn', '+');
  fab.type = 'button';
  fab.dataset.action = 'add-note';
  fab.setAttribute('aria-label', 'Add a note to this folder');
  container.appendChild(fab);
}

/* --------------------------------------------------------------------------
   Note modal
   -------------------------------------------------------------------------- */

function resetModalFields() {
  els.modalNoteText.value = '';
  els.modalNoteLink.value = '';
  els.modalNoteImgUrl.value = '';
  els.modalImgPreview.textContent = '';
  // Bug #21: without this, re-picking the SAME file fires no change event.
  if (els.modalNoteImg) els.modalNoteImg.value = '';
  ui.tempNoteImg = null;
}

function setPreview(src) {
  els.modalImgPreview.textContent = '';
  const url = safeUrl(src);
  if (!url) return;
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Selected note image preview';
  els.modalImgPreview.appendChild(img);
}

export function openAddNoteModal() {
  playSound('click');
  if (!ui.currentFolder) { toast('Open a folder first.', 'error'); return; }
  resetModalFields();
  ui.editingNoteIndex = null;
  els.modalTitle.textContent = 'Add New Note';
  openModal(els.noteModal, els.modalNoteText);
}

export function editNote(idx) {
  playSound('click');
  const folder = ui.currentFolder;
  const notes = folder ? cloud.studyMaterial[folder] : null;
  const note = notes && notes[idx];
  if (!note) { toast('That note no longer exists.', 'error'); return; }

  resetModalFields();
  ui.editingNoteIndex = idx;
  els.modalTitle.textContent = 'Edit Note';
  els.modalNoteText.value = note.text || '';
  els.modalNoteLink.value = note.link || '';

  const isDataUrl = typeof note.img === 'string' && note.img.startsWith('data:');
  ui.tempNoteImg = isDataUrl ? note.img : null;
  els.modalNoteImgUrl.value = (note.img && !isDataUrl) ? note.img : '';
  if (note.img) setPreview(note.img);

  openModal(els.noteModal, els.modalNoteText);
}

export function closeAddNoteModal() {
  closeModal(els.noteModal);
  ui.editingNoteIndex = null;
}

export function saveNoteFromModal() {
  playSound('click');

  const folder = ui.currentFolder;
  // Bug #20: the original dereferenced a null folder and threw.
  if (!folder || !Array.isArray(cloud.studyMaterial[folder])) {
    toast('The folder is no longer open — reopen it and try again.', 'error');
    closeAddNoteModal();
    return;
  }

  const text = els.modalNoteText.value.trim();
  const rawLink = els.modalNoteLink.value.trim();
  const rawImgUrl = els.modalNoteImgUrl.value.trim();
  const img = ui.tempNoteImg || rawImgUrl;

  if (!text && !img && !rawLink) { toast('The note is empty.', 'error'); return; }

  if (rawLink && !safeUrl(rawLink)) { toast('That web link is not a valid http(s) address.', 'error'); return; }
  if (rawImgUrl && !safeUrl(rawImgUrl)) { toast('That image link is not a valid http(s) address.', 'error'); return; }

  const note = { text, link: rawLink, img };

  if (ui.editingNoteIndex !== null && cloud.studyMaterial[folder][ui.editingNoteIndex]) {
    cloud.studyMaterial[folder][ui.editingNoteIndex] = note;
  } else {
    cloud.studyMaterial[folder].push(note);
  }

  persist();
  closeAddNoteModal();
  renderFolderView(folder);
  toast('Note saved.', 'success');
}

export async function deleteNote(idx) {
  const folder = ui.currentFolder;
  if (!folder || !Array.isArray(cloud.studyMaterial[folder])) return;

  const ok = await confirmDialog({ message: 'Delete this note?', okLabel: 'Delete', danger: true });
  if (!ok) return;

  cloud.studyMaterial[folder].splice(idx, 1);
  persist();
  renderFolderView(folder);
}

export function handleModalImage(input) {
  if (!input.files || !input.files[0]) return;
  compressImage(input.files[0], (dataUrl) => {
    ui.tempNoteImg = dataUrl;
    setPreview(dataUrl);
  });
}

/* --------------------------------------------------------------------------
   Image compression (800px / JPEG q0.5)
   Bug #19: the original had no reader.onerror and no img.onerror, so a HEIC
   or corrupt file silently did nothing at all.
   -------------------------------------------------------------------------- */

export function compressImage(file, callback) {
  if (!file.type || !file.type.startsWith('image/')) {
    toast('That file is not an image.', 'error');
    return;
  }

  const reader = new FileReader();

  reader.onerror = () => toast('That file could not be read. Try a JPEG or PNG.', 'error');

  reader.onload = (event) => {
    const img = new Image();

    img.onerror = () => toast('That image could not be decoded (HEIC files are not supported).', 'error');

    img.onload = () => {
      try {
        const maxWidth = 800;
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        // JPEG has no alpha; paint white so transparency does not go black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        callback(canvas.toDataURL('image/jpeg', 0.5));
      } catch (err) {
        console.error('compressImage failed', err);
        toast('That image could not be processed.', 'error');
      }
    };

    img.src = event.target.result;
  };

  reader.readAsDataURL(file);
}
