/**
 * OCR cleanup, checked against the shapes real scans actually produce:
 * running heads, page numbers, hyphenated line breaks, and sentences that
 * continue across a page boundary.
 */

const { cleanPages, isPageNumberLine, normalizeGlyphs } = await import(
  '../src/lib/ocr/cleanup.ts'
);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <- ' + extra}`);
  if (!cond) failures++;
};

// --- three pages of a paperback -------------------------------------------
const PAGES = [
  `THE LONG GOODBYE
48

was the first time I had seen him drunk in a public place. It
was not the last. He held the glass with both hands and stared
at it as though it contained something he had lost. The bar-
tender moved away and pretended to polish a glass that was
already clean.

"You want another?" he said at last.

I shook my head. Outside the rain had stopped and an Anglo-
Saxon word came into my head that I did not say.`,

  `THE LONG GOODBYE
49
~

He got up carefully, the way a man gets up when he has decided
in advance exactly how he is going to do it, and walked to the
door without touching anything on the way.`,

  `50   THE LONG GOODBYE

The street was empty. A cat crossed it without hurrying and
disappeared under a parked car.`,
];

const { text, report } = cleanPages(PAGES);

check('running head removed', !text.includes('THE LONG GOODBYE'), text.slice(0, 60));
check('page numbers removed', !/\b(48|49|50)\b/.test(text));
check('speckle removed', !text.includes('~'));
check('hyphenated word rejoined', text.includes('bartender'));
check('real compound keeps its hyphen', text.includes('Anglo-Saxon'));
check('wrapped lines joined', !text.includes('It\nwas not the last'));
check('paragraph breaks kept', text.includes('already clean.\n\n"You want another?"'));
check('report counts removals', report.removed.length === 6, report.removed.length);
check('report counts hyphen repairs', report.hyphensJoined === 2, report.hyphensJoined);

// --- a sentence continuing across a page break -----------------------------
const across = cleanPages([
  'quickly enough to prevent a swirl of gritty dust from entering along with',
  'him. The hallway smelt of boiled cabbage.',
]).text;
check(
  'sentence stitched across the page break',
  across.includes('along with him.'),
  across,
);

// --- cleanup switched off --------------------------------------------------
const raw = cleanPages([PAGES[0]], {
  unwrapLines: false,
  joinHyphenation: false,
  removePageNumbers: false,
  removeRunningHeads: false,
}).text;
check('unwrap off keeps the printed line breaks', raw.includes('It\nwas not the last'));
check('page number kept when the option is off', raw.includes('48'));

// --- unit checks -----------------------------------------------------------
check('page number: bare', isPageNumberLine('47'));
check('page number: dressed', isPageNumberLine('- 47 -') && isPageNumberLine('[47]'));
check('page number: worded', isPageNumberLine('Page 47'));
check('page number: roman', isPageNumberLine('xiv'));
check('page number: not prose', !isPageNumberLine('47 Grove Street'));
check('page number: not a lone I', !isPageNumberLine('I'));

check('ligature expanded', normalizeGlyphs('ﬁnal').includes('final'));
check('soft hyphen dropped', normalizeGlyphs('cur­ious') === 'curious');
check('margin pipe stripped', normalizeGlyphs('| the wind rose') === 'the wind rose');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
