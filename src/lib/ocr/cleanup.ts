/**
 * OCR cleanup
 * ===========
 *
 * Raw OCR output of a book page is *visually* faithful and therefore terrible
 * to listen to: every printed line ends in a hard line break, words are split
 * across lines with hyphens, and the running header and page number sit in the
 * middle of the text stream. Read aloud verbatim you get
 *
 *     "...he opened the door and                 <pause>
 *      walked in. 47                             <pause>
 *      THE LONG GOODBYE                          <pause>
 *      It was rain-                              <pause>
 *      ing again..."
 *
 * This module turns that back into prose.
 *
 * Design rules:
 *  - Only structural fixes. We never "correct" words against a dictionary —
 *    an OCR error you can hear is far better than a confident wrong guess you
 *    can't, and the user gets an editable textarea anyway.
 *  - Every destructive step is reported in `CleanupReport` so the UI can tell
 *    the user what was dropped, and every step is individually switchable.
 *  - Header/footer detection needs *all* pages at once (it works by finding
 *    lines that repeat across pages), which is why the entry point takes an
 *    array rather than being called per page.
 */

export interface CleanupOptions {
  /** Drop lines that repeat at the top/bottom of most pages (running heads). */
  removeRunningHeads: boolean;
  /** Drop lines at a page edge that are just a page number. */
  removePageNumbers: boolean;
  /** Re-join words split across a line break with a hyphen. */
  joinHyphenation: boolean;
  /** Re-join lines that are only line breaks because the column ran out. */
  unwrapLines: boolean;
}

export const defaultCleanupOptions: CleanupOptions = {
  removeRunningHeads: true,
  removePageNumbers: true,
  joinHyphenation: true,
  unwrapLines: true,
};

export interface CleanupReport {
  /** Lines removed, with the reason, so the UI can show "8 artifacts removed". */
  removed: { line: string; reason: 'running-head' | 'page-number' | 'noise' }[];
  hyphensJoined: number;
  linesUnwrapped: number;
}

const EMPTY_REPORT = (): CleanupReport => ({
  removed: [],
  hyphensJoined: 0,
  linesUnwrapped: 0,
});

// ---------------------------------------------------------------------------
// Step 1: character-level normalisation
// ---------------------------------------------------------------------------

/**
 * Fix the characters OCR reliably gets *typographically* wrong. These are safe
 * one-to-one substitutions — no guessing about words.
 */
export function normalizeGlyphs(input: string): string {
  return (
    input
      .replace(/\r\n?/g, '\n')
      // Ligatures: Tesseract emits real ligature codepoints for common ones.
      .replace(/ﬀ/g, 'ff')
      .replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl')
      .replace(/ﬃ/g, 'ffi')
      .replace(/ﬄ/g, 'ffl')
      .replace(/ﬅ|ﬆ/g, 'st')
      // Invisible characters that break word matching later on.
      .replace(/­/g, '') // soft hyphen
      .replace(/[​-‍﻿]/g, '') // zero-width
      .replace(/ /g, ' ') // nbsp
      // Normalise the many dash and quote shapes to a small, speakable set.
      .replace(/[‐‑‒⁃]/g, '-') // hyphen variants
      .replace(/[–—]/g, '—') // en dash -> em dash
      .replace(/[‘’‚‛`´]/g, "'")
      .replace(/[“”„‟«»]/g, '"')
      .replace(/…/g, '...')
      // Tesseract loves to read the gutter/margin of a photo as a pipe or a
      // stray bracket at the very start or end of a line.
      .replace(/^[|¦\\/]+[ \t]*/gm, '')
      .replace(/[ \t]*[|¦]+$/gm, '')
      // Trailing whitespace per line, and tabs -> spaces.
      .replace(/[ \t]+/g, ' ')
      .replace(/ +$/gm, '')
  );
}

// ---------------------------------------------------------------------------
// Step 2: line classification
// ---------------------------------------------------------------------------

const ROMAN = /^[ivxlcdm]+$/i;

/**
 * True if a line is *only* a page number in one of the usual dressings:
 * "47", "- 47 -", "[47]", "Page 47", "47 |", "xiv".
 */
export function isPageNumberLine(line: string): boolean {
  const s = line.trim().replace(/^[[({\-–—*.\s]+|[\])}\-–—*.\s]+$/g, '');
  if (!s) return false;
  if (/^\d{1,4}$/.test(s)) return true;
  if (/^page\s+\d{1,4}$/i.test(s)) return true;
  // Roman numerals for front matter — but "I" and "V" and "MIX" are real
  // words/initials, so require either length >= 2 and lowercase, or a
  // multi-character uppercase numeral that isn't a common word.
  if (ROMAN.test(s) && s.length >= 2 && !/^(mix|dim|did|lid|mid|cid)$/i.test(s))
    return true;
  return false;
}

/**
 * Garbage lines: speckle on the photo, a rule under a heading, a stray mark.
 * Requires the line to contain no letters at all *and* be short, so that real
 * content like "1984." or "$5,000" survives.
 */
function isNoiseLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (s.length > 12) return false;
  if (/[a-z0-9]/i.test(s)) return false;
  return true;
}

/**
 * Normalise a line for cross-page comparison: lowercase, strip digits (page
 * numbers ride along with running heads: "48  THE LONG GOODBYE"), collapse
 * non-letters. Two headers match if their skeletons match, which tolerates the
 * odd OCR character error.
 */
function headerSkeleton(line: string): string {
  return line
    .toLowerCase()
    .replace(/\d+/g, '')
    .replace(/[^a-z]+/g, '')
    .trim();
}

/**
 * Find lines that appear at the top or bottom edge of most pages — that is the
 * definition of a running head/foot. Needs >= 3 pages to be meaningful;
 * with fewer we'd risk deleting a real repeated sentence.
 */
function findRunningHeads(pages: string[][]): Set<string> {
  const heads = new Set<string>();
  if (pages.length < 3) return heads;

  const counts = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    const edge = [...lines.slice(0, 2), ...lines.slice(-2)];
    for (const line of edge) {
      const key = headerSkeleton(line);
      // Skeletons need enough letters to be distinctive.
      if (key.length < 4) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  for (const [key, n] of counts) if (n >= threshold) heads.add(key);
  return heads;
}

// ---------------------------------------------------------------------------
// Step 3: un-wrapping a page's lines back into paragraphs
// ---------------------------------------------------------------------------

const TERMINAL = /[.!?][")']*$/;
const LIST_MARKER = /^(\s*[-*•‣·]|\s*\(?\d{1,3}[.)]|\s*[a-z][.)])\s+/i;

/**
 * Decide whether the break after `line` is a real paragraph break or just the
 * printed column running out of room.
 *
 * The signal that actually works on book scans is line *length*: body text is
 * justified to a consistent width, so a line noticeably shorter than the page's
 * typical line is the last line of a paragraph. Terminal punctuation alone is
 * not enough ("...said Dr. \n Kemp" ends in a period mid-sentence) and neither
 * is capitalisation ("The \n Republic" wraps mid-sentence).
 */
function isParagraphEnd(line: string, next: string, typicalWidth: number): boolean {
  if (!next.trim()) return true;
  if (LIST_MARKER.test(next)) return true;
  // A heading-ish short line (no terminal punctuation, title case) stands alone.
  if (line.length < typicalWidth * 0.5 && !TERMINAL.test(line) && /^[^a-z]*$/.test(line))
    return true;
  if (!TERMINAL.test(line)) return false;
  // Ends a sentence AND is short for this page => end of paragraph.
  return line.length < typicalWidth * 0.85;
}

/** Median-ish typical line width for a page, ignoring very short lines. */
function typicalLineWidth(lines: string[]): number {
  const lens = lines
    .map((l) => l.trim().length)
    .filter((n) => n > 20)
    .sort((a, b) => a - b);
  if (!lens.length) return 60;
  // 75th percentile tracks the justified body width better than the median,
  // because paragraph-final short lines drag the median down.
  return lens[Math.floor(lens.length * 0.75)];
}

/**
 * Re-join words split across a line break by the typesetter's hyphenation.
 * Runs as a pre-pass so the paragraph logic below only ever sees whole words.
 *
 *   "he was walk-"  +  "ing home slowly"  ->  "he was walking home slowly"
 *
 * A capitalised continuation is left hyphenated, because that is nearly always
 * a real compound that happened to land on the break ("Anglo-" + "Saxon").
 */
function dehyphenate(input: string[], report: CleanupReport): string[] {
  const lines = [...input];
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/[A-Za-z]-$/.test(line)) {
      const next = (lines[i + 1] ?? '').trim();
      if (next) {
        const spaceAt = next.indexOf(' ');
        const firstWord = spaceAt === -1 ? next : next.slice(0, spaceAt);
        const rest = spaceAt === -1 ? '' : next.slice(spaceAt + 1);
        line = (/^[A-Z]/.test(firstWord) ? line : line.slice(0, -1)) + firstWord;
        report.hyphensJoined++;
        if (rest) {
          lines[i + 1] = rest;
        } else {
          i++; // the next line was one word and has been absorbed entirely
        }
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Join one page's lines into paragraphs.
 * Paragraphs are separated by "\n\n"; nothing else emits a newline.
 */
function unwrapPage(
  rawLines: string[],
  opts: CleanupOptions,
  report: CleanupReport,
): string {
  const lines = opts.joinHyphenation ? dehyphenate(rawLines, report) : rawLines;

  // Un-wrapping disabled: keep the printed line breaks exactly as scanned.
  if (!opts.unwrapLines) return lines.join('\n').replace(/\n{3,}/g, '\n\n');

  const width = typicalLineWidth(lines);
  const paragraphs: string[] = [];
  let buf = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = (lines[i + 1] ?? '').trim();

    if (!line) {
      if (buf) {
        paragraphs.push(buf);
        buf = '';
      }
      continue;
    }

    buf = buf ? `${buf} ${line}` : line;

    if (isParagraphEnd(line, next, width)) {
      paragraphs.push(buf);
      buf = '';
    } else if (next) {
      report.linesUnwrapped++;
    }
  }
  if (buf) paragraphs.push(buf);

  return paragraphs.join('\n\n');
}

// ---------------------------------------------------------------------------
// Step 4: final tidy
// ---------------------------------------------------------------------------

function tidy(text: string): string {
  return (
    text
      // OCR often leaves a space before punctuation ("word ,").
      .replace(/ +([,.;:!?])/g, '$1')
      // ...and drops the space after it ("word,next") — only fix when the next
      // char is a letter and the previous token looks like a word, to avoid
      // mangling "3.14" or "e.g."
      .replace(/([a-z]{2}),([A-Za-z])/g, '$1, $2')
      .replace(/ {2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface CleanupResult {
  text: string;
  report: CleanupReport;
}

/**
 * Clean an array of per-page OCR strings into a single readable document.
 * Pages are joined with a blank line, unless the previous page ended
 * mid-sentence, in which case the sentence is stitched back together.
 */
export function cleanPages(
  pages: string[],
  options: Partial<CleanupOptions> = {},
): CleanupResult {
  const opts = { ...defaultCleanupOptions, ...options };
  const report = EMPTY_REPORT();

  // 1. normalise characters, then split into lines
  const pageLines = pages.map((p) =>
    normalizeGlyphs(p)
      .split('\n')
      .map((l) => l.trim()),
  );

  // 2. drop page-edge junk
  const runningHeads = opts.removeRunningHeads ? findRunningHeads(pageLines) : new Set<string>();

  const kept = pageLines.map((lines) =>
    lines.filter((line, idx) => {
      if (!line) return true; // blank lines carry paragraph structure
      const atEdge = idx < 2 || idx >= lines.length - 2;

      if (atEdge && runningHeads.has(headerSkeleton(line))) {
        report.removed.push({ line, reason: 'running-head' });
        return false;
      }
      if (opts.removePageNumbers && atEdge && isPageNumberLine(line)) {
        report.removed.push({ line, reason: 'page-number' });
        return false;
      }
      if (isNoiseLine(line)) {
        report.removed.push({ line, reason: 'noise' });
        return false;
      }
      return true;
    }),
  );

  // 3. un-wrap each page independently (line width differs page to page)
  const pageTexts = kept.map((lines) => unwrapPage(lines, opts, report));

  // 4. stitch pages: continue the sentence across the page break when the
  //    previous page didn't end on terminal punctuation.
  let out = '';
  for (const pageText of pageTexts) {
    if (!pageText.trim()) continue;
    if (!out) {
      out = pageText;
      continue;
    }
    const continues = opts.unwrapLines && !TERMINAL.test(out.trimEnd());
    out += continues ? ` ${pageText}` : `\n\n${pageText}`;
  }

  return { text: tidy(out), report };
}
