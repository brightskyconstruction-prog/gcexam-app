/* ===========================================================================
   parse-source.js — book / chapter extraction, memoised.
   Bug #46: the original recomputed this for every item on every keystroke and
   every mode switch (1001 items x ~5 regex ops). Results are now cached by
   record id and computed at most once per record.
   =========================================================================== */

const cache = new Map();

/* Bug #39: " or " splitting used to cut legitimate names like "Doors or
   Windows". We only treat " or " as a separator when both sides look like a
   source reference (i.e. contain a chapter/section marker or a comma). */
function looksLikeSource(text) {
  return /,|\bchapter\b|\bsection\b|\bsubpart\b|\btable\b/i.test(text);
}

function splitSegments(item, srcText) {
  if (srcText.includes(' or ')) {
    const parts = srcText.split(' or ');
    if (parts.every(looksLikeSource)) return parts;
  }
  if (item.source && srcText.includes(',')) {
    // Multi-source MCQ: "IBC Chapter 19 (Concrete), IRC Chapter 4 (...)".
    // The lookahead keeps commas that sit inside parentheses.
    return srcText.split(/,(?![^()]*\))/);
  }
  return [srcText];
}

function parseSegment(segment) {
  let clean = segment.trim().replace(/\(.*?\)/g, '').trim();

  let book = 'General';
  let chapter = 'General';
  let section = '';

  if (clean.includes(',')) {
    // "Book, Chapter N" — and sometimes "Book, Chapter N, Section: X".
    // Bug #39: the third segment used to be dropped entirely.
    const parts = clean.split(',').map((p) => p.trim()).filter(Boolean);
    book = parts[0] || 'General';
    chapter = parts[1] || 'General';
    if (parts.length > 2) section = parts.slice(2).join(', ');
  } else if (clean.includes(' - ')) {
    const parts = clean.split(' - ');
    book = parts[0].trim();
    chapter = parts[1].trim();
    if (parts.length > 2) section = parts.slice(2).join(' - ').trim();
  } else {
    const match = clean.match(/^(.*?) (Chapter \d+|Subpart [A-Z]+|Section .*|\d+.*)/i);
    if (match) {
      book = match[1].trim();
      chapter = match[2].trim();
    } else {
      const firstSpace = clean.indexOf(' ');
      if (firstSpace > 0) {
        book = clean.substring(0, firstSpace).trim();
        chapter = clean.substring(firstSpace).trim();
      } else if (clean) {
        book = clean;
      }
    }
  }

  return { book: book || 'General', chapter: chapter || 'General', section };
}

/** @returns {Array<{book:string, chapter:string, section:string}>} */
export function parseSource(item) {
  if (!item) return [];
  if (item.id && cache.has(item.id)) return cache.get(item.id);

  let srcText = '';
  if (item.source) {
    srcText = item.source;
  } else if (item.a) {
    const match = item.a.match(/\[Source:(.*?)\]/i);
    srcText = match ? match[1] : item.a;
  }

  srcText = srcText.replace(/[[\]]/g, '').trim();

  const result = splitSegments(item, srcText).map(parseSegment);
  if (item.id) cache.set(item.id, result);
  return result;
}

/** Bug #38: "Chapter 10" used to sort before "Chapter 2". */
export function naturalSort(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Build { [book]: Set<chapter> } for a dataset, memoised per dataset object. */
const structureCache = new WeakMap();

export function buildBookStructure(data) {
  if (structureCache.has(data)) return structureCache.get(data);

  const structure = {};
  for (const item of data) {
    for (const { book, chapter } of parseSource(item)) {
      if (!structure[book]) structure[book] = new Set();
      structure[book].add(chapter);
    }
  }
  structureCache.set(data, structure);
  return structure;
}

export function clearCache() {
  cache.clear();
}
