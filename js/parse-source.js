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

/* Study QA (mcq.json) citations were rewritten to the enriched
   "Book Title, Chapter N — Chapter Name — Section: X" format, and records
   that cite more than one source now join the individual citations with
   "; " instead of a bare comma. That's deliberate: a citation's own book
   name can itself legitimately contain a comma (e.g. the BCSI guide's full
   title), so a plain top-level comma can no longer be trusted as the
   boundary between two different citations the way it could for the old
   "Book Chapter N (Title), Book Chapter N (Title)" format. */
function splitSegments(item, srcText) {
  // A generated Section phrase can legitimately contain the word " or "
  // (e.g. "trimmer or jack studs"), which would otherwise get mistaken for
  // the old " or "-joined-citations separator. Any string carrying the new
  // pipe format ("; " between citations, or a "—" inside one) skips that
  // legacy heuristic entirely -- real multi-citation records always use
  // "; " now, never " or ".
  const isNewFormat = Boolean(item.source) && (srcText.includes('; ') || srcText.includes('—'));
  if (!isNewFormat && srcText.includes(' or ')) {
    const parts = srcText.split(' or ');
    if (parts.every(looksLikeSource)) return parts;
  }
  if (item.source && srcText.includes('; ')) {
    return srcText.split(/;\s*/).filter(Boolean);
  }
  // Book Topics QA (raw-topics.json, item.a) never used a segment-level
  // multi-source separator historically -- its "Book, Chapter N (Title)"
  // citations are parsed as a single segment and split internally by
  // parseLegacySegment. Preserved as-is; out of scope for this pass.
  return [srcText];
}

/* Matches the marker word/number that starts the part of a new-format
   citation after "Book Title,": "Chapter 7", "Subpart R", "Appendix G",
   "B1", "Introduction", or "Unverified" (the small number of citations that
   couldn't be safely auto-corrected -- see the validation report -- where
   the book is still known but the chapter/section mapping is not). Used to
   confirm a top-level comma really is the book/chapter boundary (and not,
   say, a comma inside a book's own title that happens to fall outside any
   parentheses). */
const NEW_FORMAT_MARKER_RE = /^(Chapter\s+\S+|Subpart\s+\S+|Appendix(?:\s+\S+)?|B\d+|Introduction|Unverified)\b/i;
const TOPLEVEL_COMMA_RE = /,(?![^()]*\))/;

function parseNewFormatSegment(raw) {
  const m = raw.match(TOPLEVEL_COMMA_RE);
  if (!m) return null;
  const idx = m.index;
  const book = raw.slice(0, idx).trim();
  let rest = raw.slice(idx + 1).trim();
  if (!book || !NEW_FORMAT_MARKER_RE.test(rest)) return null;

  let section = '';
  const secMatch = rest.match(/—\s*Section:\s*(.+)$/i);
  if (secMatch) {
    section = secMatch[1].trim();
    rest = rest.slice(0, secMatch.index).trim().replace(/—\s*$/, '').trim();
  }

  return { book, chapter: rest || 'General', section };
}

/* Original book/chapter parser, kept as-is for: (a) Book Topics QA
   (raw-topics.json) records, whose "Book, Chapter N (Title)" citations
   never use the new "—" section marker, and (b) the handful of Study QA
   citations that couldn't be safely auto-corrected and were deliberately
   left in their original, unmodified text (see the validation report's
   manual-review list) rather than guessed at. */
function parseLegacySegment(segment) {
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

/* allowNewFormat is only true for item.source (Study QA / mcq.json) records
   -- item.a (Book Topics QA / raw-topics.json) citations never use the new
   "—" pipe format, so they always go straight to the legacy parser. This
   keeps the two datasets' parsing fully independent even though they share
   this module. */
function parseSegment(segment, allowNewFormat) {
  const raw = segment.trim();
  if (allowNewFormat) {
    const parsed = parseNewFormatSegment(raw);
    if (parsed) return parsed;
  }
  return parseLegacySegment(raw);
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

  const allowNewFormat = Boolean(item.source);
  const result = splitSegments(item, srcText).map((seg) => parseSegment(seg, allowNewFormat));
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
