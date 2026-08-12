/**
 * Turn a document into the two units playback needs:
 *
 *   tokens    — one per visible word, with its character range in the source
 *               text. This is what gets highlighted, and what a tap maps to.
 *   sentences — the unit we actually hand to the speech engine, and the unit
 *               "skip forward/back" moves by.
 *
 * Speaking one sentence at a time (rather than the whole document in one
 * utterance) buys three things:
 *   1. skip-by-sentence and tap-to-seek become trivial;
 *   2. any drift in the highlight resets at every sentence boundary;
 *   3. it dodges the long-standing Chrome bug where a long utterance is
 *      silently truncated after ~15 seconds.
 */

export interface Token {
  /** Character offset in the source text, inclusive. */
  start: number;
  /** Character offset in the source text, exclusive. */
  end: number;
  text: string;
  /** Index into `sentences`. */
  sentence: number;
}

export interface Sentence {
  start: number;
  end: number;
  /** Index of the first token in this sentence. */
  firstToken: number;
  /** Index of the last token in this sentence, inclusive. */
  lastToken: number;
}

export interface Tokenized {
  text: string;
  tokens: Token[];
  sentences: Sentence[];
}

/**
 * Words that end in a period without ending a sentence. Kept short on purpose:
 * a missed abbreviation costs one spurious pause, while a wrong entry here can
 * swallow a real sentence break.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'hon', 'st', 'sr', 'jr',
  'vs', 'etc', 'al', 'ca', 'cf', 'ed', 'eds', 'esp', 'fig', 'figs',
  'no', 'nos', 'vol', 'vols', 'ch', 'chap', 'pp', 'approx', 'inc',
  'ltd', 'co', 'corp', 'dept', 'univ', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/**
 * A sentence longer than this is split at the next comma-ish break. Very long
 * sentences make "skip back one sentence" useless and give the fallback
 * highlight estimator too much room to drift.
 */
const SOFT_MAX_CHARS = 260;
/** Absolute ceiling — split at any word boundary past this. */
const HARD_MAX_CHARS = 480;

const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/;
const SOFT_BREAK = /[,;:—-]["'”’)\]]*$/;
/** "J." or "T." — an initial, not the end of a sentence. */
const INITIAL = /^[A-Z]\.$/;

/** Strip surrounding punctuation to get the bare word for abbreviation lookup. */
function bareWord(token: string): string {
  return token.replace(/[^A-Za-z]/g, '').toLowerCase();
}

/** Can this token legitimately start a new sentence? */
function looksLikeSentenceStart(token: string | undefined): boolean {
  if (!token) return true; // end of document
  return /^["'“‘([]?[A-Z0-9]/.test(token);
}

export function tokenize(text: string): Tokenized {
  const tokens: Token[] = [];
  const wordRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      sentence: 0,
    });
  }

  const sentences: Sentence[] = [];
  let firstToken = 0;

  const close = (lastToken: number) => {
    for (let i = firstToken; i <= lastToken; i++) tokens[i].sentence = sentences.length;
    sentences.push({
      start: tokens[firstToken].start,
      end: tokens[lastToken].end,
      firstToken,
      lastToken,
    });
    firstToken = lastToken + 1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    const length = token.end - tokens[firstToken].start;

    // A blank line between two words is always a break — it is a paragraph.
    const gap = next ? text.slice(token.end, next.start) : '';
    if (!next || /\n[ \t]*\n/.test(gap)) {
      close(i);
      continue;
    }

    if (
      ENDS_SENTENCE.test(token.text) &&
      !INITIAL.test(token.text) &&
      !ABBREVIATIONS.has(bareWord(token.text)) &&
      looksLikeSentenceStart(next.text)
    ) {
      close(i);
      continue;
    }

    // Runaway sentence: break at a comma past the soft limit, or anywhere
    // past the hard limit.
    if (
      (length > SOFT_MAX_CHARS && SOFT_BREAK.test(token.text)) ||
      length > HARD_MAX_CHARS
    ) {
      close(i);
    }
  }

  return { text, tokens, sentences };
}

/**
 * Token containing (or immediately following) a character offset.
 * Binary search — this runs on every word boundary event.
 */
export function tokenAtChar(tokens: Token[], charIndex: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].end <= charIndex) {
      lo = mid + 1;
    } else {
      best = mid;
      hi = mid - 1;
    }
  }
  return best;
}

/** Word count, for the library card and time estimates. */
export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
