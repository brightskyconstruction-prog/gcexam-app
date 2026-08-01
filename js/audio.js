/* ===========================================================================
   audio.js — Web Audio SFX/haptics + Web Speech TTS engine.
   =========================================================================== */

import { ui, savePrefs, flagsFor, chapterFor } from './state.js';
import { isStudyView } from './modes.js';
import { els, highlightIndex, clearHighlight, toast } from './render.js';

/* --------------------------------------------------------------------------
   Sound effects
   -------------------------------------------------------------------------- */

let audioCtx = null;

export function initAudio() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { audioCtx = null; }
  return audioCtx;
}

/** Bug #48: release the context when the page is backgrounded/unloaded. */
export function releaseAudio() {
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

export function playSound(type) {
  if (!ui.sfxEnabled) return;
  const ctx = initAudio();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  const now = ctx.currentTime;

  if (type === 'correct') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.1);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    osc.start(now); osc.stop(now + 0.5);
  } else if (type === 'wrong') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.linearRampToValueAtTime(100, now + 0.3);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
    osc.start(now); osc.stop(now + 0.3);
  } else {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(400, now);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
    osc.start(now); osc.stop(now + 0.05);
  }

  osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (_) {} };
}

/** Bug #41: haptics are part of the SFX toggle, as the button implies. */
export function vibrate(pattern) {
  if (!ui.sfxEnabled) return;
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (_) {} }
}

export function toggleSFX() {
  ui.sfxEnabled = !ui.sfxEnabled;
  savePrefs({ sfxEnabled: ui.sfxEnabled });
  const btn = els['btn-sfx'];
  if (btn) {
    btn.classList.toggle('muted', !ui.sfxEnabled);
    btn.textContent = ui.sfxEnabled ? '🔊' : '🔇';
    btn.setAttribute('aria-pressed', ui.sfxEnabled ? 'true' : 'false');
    btn.setAttribute('aria-label', ui.sfxEnabled ? 'Sound effects on' : 'Sound effects off');
  }
  if (ui.sfxEnabled) playSound('click');
}

/* --------------------------------------------------------------------------
   Text-to-speech
   -------------------------------------------------------------------------- */

const synth = window.speechSynthesis;

/* Bug #17: `Date.now()` collided when two invalidations happened inside the
   same millisecond, leaving a stale chunk chain alive. Monotonic counter. */
let speechToken = 0;

let selectedVoice = null;
let voicePrimed = false;

export const player = {
  index: 0,
  playing: false,
  paused: false,
  itemsRef: () => (isStudyView() ? ui.visibleItems : ui.currentMCQItems)
};

export function loadVoices() {
  if (!synth) return;
  const voices = synth.getVoices();
  if (!voices || voices.length === 0) return;
  /* Bug #30: `|| voices[0]` could pick any language. Fall back to null and let
     the browser choose its own default English voice. */
  selectedVoice =
    voices.find((v) => v.localService && v.lang && v.lang.toLowerCase().startsWith('en')) ||
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('en')) ||
    null;
}

/* Bug #29: the original called synth.speak(' ') at load, which throws
   `not-allowed` where a user gesture is required. Prime on first interaction. */
export function primeVoice() {
  if (voicePrimed || !synth) return;
  voicePrimed = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
    synth.cancel();
  } catch (_) { /* harmless */ }
}

function setStatus(text) {
  if (els.statusDisplay) els.statusDisplay.textContent = text;
}

function setPlayButton(playing) {
  const btn = els.playPauseBtn;
  if (!btn) return;
  btn.textContent = playing ? '⏸' : '▶';
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? 'Pause reading' : 'Start reading');
  btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
}

/* Bug #18: Chrome silently truncates utterances longer than ~15 s. Split long
   text on sentence, then clause, then word boundaries at ~180 characters. */
const MAX_UTTERANCE = 180;

function splitLongText(text) {
  const clean = String(text || '').trim();
  if (clean.length <= MAX_UTTERANCE) return clean ? [clean] : [];

  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
  const out = [];
  let buffer = '';

  const push = () => { if (buffer.trim()) out.push(buffer.trim()); buffer = ''; };

  for (const sentence of sentences) {
    if (sentence.length > MAX_UTTERANCE) {
      push();
      for (const word of sentence.split(/\s+/)) {
        if ((buffer + ' ' + word).trim().length > MAX_UTTERANCE) push();
        buffer += (buffer ? ' ' : '') + word;
      }
      push();
    } else if ((buffer + sentence).length > MAX_UTTERANCE) {
      push();
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  push();
  return out;
}

/* Chrome pauses long queues when the tab loses focus; a periodic
   resume() keeps the engine alive while we are playing. */
let keepAlive = null;

function startKeepAlive() {
  stopKeepAlive();
  keepAlive = setInterval(() => {
    if (!player.playing || player.paused) return;
    if (synth && synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
  }, 10000);
}

function stopKeepAlive() {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

function speakChunks(chunks, token, onComplete) {
  // Expand each logical chunk into engine-sized pieces, keeping its type.
  const queue = [];
  for (const chunk of chunks) {
    const pieces = splitLongText(chunk.text);
    pieces.forEach((text, i) => {
      queue.push({ text, type: chunk.type, last: i === pieces.length - 1 });
    });
  }

  let i = 0;

  function next() {
    if (!player.playing || token !== speechToken) return;
    if (i >= queue.length) { onComplete(); return; }

    const chunk = queue[i];
    const u = new SpeechSynthesisUtterance(chunk.text + '.');
    if (selectedVoice) u.voice = selectedVoice;

    // Long answers are slowed 10% for clarity (preserved from the original).
    let rate = ui.speechRate;
    if (chunk.type === 'a' && chunk.text.length > 60) rate = Math.max(0.25, ui.speechRate * 0.9);
    u.rate = rate;

    u.onend = () => {
      if (!player.playing || token !== speechToken) return;
      let pause = 300;
      if (!chunk.last) pause = 120;                    // mid-sentence continuation
      else if (chunk.type === 'lead') pause = 100;
      else if (chunk.type === 'a') pause = 1500;       // time to memorise the answer
      else if (chunk.type === 'src') pause = 1000;
      i += 1;
      setTimeout(next, pause);
    };

    /* Bug (audit note on 19184): synth.cancel() fires onerror for every queued
       utterance, which used to storm this handler. The token guard stops the
       chain dead on a genuine cancellation. */
    u.onerror = (event) => {
      if (!player.playing || token !== speechToken) return;
      if (event && (event.error === 'canceled' || event.error === 'interrupted')) return;
      i += 1;
      setTimeout(next, 100);
    };

    const shown = player.index + 1;
    if (chunk.type === 'a') setStatus(`Q${shown}: Answer...`);
    else if (chunk.type === 'src') setStatus(`Q${shown}: Source...`);
    else setStatus(`Reading Q${shown} (${formatRate(ui.speechRate)})`);

    try { synth.speak(u); } catch (err) { console.error('speak failed', err); }
  }

  next();
}

function readStudyCard(index, token) {
  const items = ui.visibleItems;
  if (!player.playing || token !== speechToken || index >= items.length) {
    if (index >= items.length) stopAudio();
    return;
  }
  player.index = index;
  highlightIndex(index);

  const item = items[index];
  const answerRaw = String(item.a || '').replace(/\[Source:.*?\]/gi, '').trim();

  let sourceRaw = '';
  const match = String(item.a || '').match(/\[Source:(.*?)\]/i);
  if (match) sourceRaw = match[1].trim();
  else if (item.source) sourceRaw = item.source;

  if (flagsFor(item).includes(4) && chapterFor(item)) {
    sourceRaw += (sourceRaw ? ', ' : '') + chapterFor(item);
  }

  const chunks = [
    { text: `Question ${item.displayId}. ${item.q}`, type: 'q' },
    { text: 'The answer is...', type: 'lead' },
    { text: answerRaw, type: 'a' }
  ];
  if (sourceRaw) chunks.push({ text: `Source... ${sourceRaw}`, type: 'src' });

  speakChunks(chunks, token, () => readStudyCard(index + 1, token));
}

function readMCQCard(index, token) {
  const items = ui.currentMCQItems;
  if (!player.playing || token !== speechToken || index >= items.length) {
    if (index >= items.length) stopAudio();
    return;
  }
  player.index = index;
  highlightIndex(index);

  const item = items[index];
  const chunks = [
    { text: `Question ${item.displayId}. ${item.q}`, type: 'q' },
    { text: 'The correct answer is...', type: 'lead' },
    { text: item.options[item.correct], type: 'a' }
  ];
  if (item.source) chunks.push({ text: `Source... ${item.source}`, type: 'src' });

  speakChunks(chunks, token, () => readMCQCard(index + 1, token));
}

function readAt(index, token) {
  if (isStudyView()) readStudyCard(index, token);
  else readMCQCard(index, token);
}

export function playAudio() {
  playSound('click');
  primeVoice();
  if (!synth) { toast('Speech synthesis is not available in this browser.', 'error'); return; }

  /* Bug #16: the original's "pause" was really a stop, and "play" re-read the
     card from chunk 0. A genuine resume is now possible. */
  if (player.paused && synth.paused) {
    player.paused = false;
    player.playing = true;
    synth.resume();
    setPlayButton(true);
    startKeepAlive();
    return;
  }

  const items = player.itemsRef();
  if (!items || items.length === 0) { toast('Nothing to read in the current list.', 'error'); return; }
  if (player.index >= items.length) player.index = 0;

  player.playing = true;
  player.paused = false;
  setPlayButton(true);
  speechToken += 1;
  synth.cancel();
  startKeepAlive();
  readAt(player.index, speechToken);
}

export function pauseAudio() {
  if (!synth) return;
  player.playing = false;
  player.paused = true;
  try { synth.pause(); } catch (_) {}
  setPlayButton(false);
  setStatus('Paused');
  stopKeepAlive();
}

export function togglePlay() {
  if (player.playing) pauseAudio();
  else playAudio();
}

export function stopAudio() {
  player.playing = false;
  player.paused = false;
  speechToken += 1;
  if (synth) { try { synth.cancel(); } catch (_) {} }
  setPlayButton(false);
  clearHighlight();
  setStatus('Stopped');
  stopKeepAlive();
}

/** Bug #32: skipping back from the first card is a no-op with feedback. */
export function skip(dir) {
  const items = player.itemsRef();
  if (!items || items.length === 0) return;

  const next = player.index + dir;
  if (next < 0) { toast('Already at the first question.'); return; }
  if (next >= items.length) { stopAudio(); toast('Reached the end of the list.'); return; }

  speechToken += 1;
  if (synth) { try { synth.cancel(); } catch (_) {} }
  player.index = next;
  player.paused = false;

  if (player.playing) readAt(player.index, speechToken);
  else highlightIndex(player.index);
}

/**
 * Bug #25: the original jumped to the Nth item in the filtered list while the
 * cards displayed `item.id` and the status bar showed `currentIndex + 1` —
 * three numbering systems at once. We now match the number printed on the
 * card, falling back to position only if nothing matches.
 */
export function jumpToNumber(rawValue) {
  const items = player.itemsRef();
  if (!items || items.length === 0) { toast('Nothing to jump to.', 'error'); return; }

  const value = String(rawValue || '').trim().toUpperCase();
  if (!value) return;

  let target = items.findIndex((item) => String(item.displayId).toUpperCase() === value);
  if (target < 0) {
    const asNumber = parseInt(value, 10);
    if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= items.length) target = asNumber - 1;
  }
  if (target < 0) {
    toast(`Question ${value} is not in the current list.`, 'error');
    return;
  }

  stopAudio();
  player.index = target;
  player.playing = true;
  player.paused = false;
  setPlayButton(true);
  speechToken += 1;
  readAt(player.index, speechToken);
}

/** Bug #31: "1" vs "1.0" — one consistent label. */
export function formatRate(rate) {
  return `${Number(rate).toFixed(2).replace(/\.?0+$/, '')}×`;
}

const RATES = [1, 1.25, 1.5, 2, 0.75, 0.5, 0.25];

export function cycleSpeed() {
  playSound('click');
  const idx = RATES.indexOf(ui.speechRate);
  ui.speechRate = RATES[(idx + 1) % RATES.length];
  savePrefs({ speechRate: ui.speechRate });

  if (els.speedBtn) {
    els.speedBtn.textContent = formatRate(ui.speechRate);
    els.speedBtn.setAttribute('aria-label', `Reading speed ${formatRate(ui.speechRate)}. Tap to change.`);
  }

  if (player.playing) {
    speechToken += 1;
    if (synth) { try { synth.cancel(); } catch (_) {} }
    readAt(player.index, speechToken);
  }
}

export function setPlayerIndex(index) {
  player.index = Math.max(0, index || 0);
}

export function initSpeed() {
  if (els.speedBtn) {
    els.speedBtn.textContent = formatRate(ui.speechRate);
    els.speedBtn.setAttribute('aria-label', `Reading speed ${formatRate(ui.speechRate)}. Tap to change.`);
  }
}

export function initVoices() {
  if (!synth) return;
  loadVoices();
  if (typeof synth.onvoiceschanged !== 'undefined') synth.onvoiceschanged = loadVoices;
}
