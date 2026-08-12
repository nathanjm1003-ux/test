# Page to Voice

Photograph a book page, get an audiobook. The text is extracted in the browser,
read aloud, and each word is highlighted as it is spoken. Documents are saved
locally and resume where you left off.

Everything runs client-side — no server, no account, no API key, and nothing
leaves the device.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173, and on your phone at http://<your-ip>:5173
```

The dev server binds to all interfaces so you can open it on a phone on the
same Wi-Fi, which is where scanning actually happens. Camera capture uses a
file input, so it works over plain `http://` on the LAN.

```bash
npm run build    # production build into dist/
npm run preview  # serve dist/ locally
npm test         # cleanup + playback logic (39 assertions, no test framework)
```

`npm install` and the first `npm run dev` will fetch about 4 MB of OCR language
data into `public/tesseract/` (git-ignored). If that download fails the app
falls back to Tesseract's CDN at runtime and tells you so in the console.

## How it works

```
photo / PDF ─▶ imagePrep ─▶ Tesseract ─▶ cleanup ─▶ editable text
                    │                                    │
              (PDF with a text                       tokenize
               layer skips OCR)                          │
                                                     Player ──▶ TtsEngine
                                                        │           │
                                                    Reader ◀────────┘
                                                 (word highlighting)
```

| Path | What it does |
| --- | --- |
| `src/lib/ocr/imagePrep.ts` | EXIF-correct decode, resize to ~300dpi-equivalent, grayscale + percentile contrast stretch |
| `src/lib/ocr/pdf.ts` | Uses a PDF's text layer when it has one; only renders and OCRs the pages that don't |
| `src/lib/ocr/ocr.ts` | One shared Tesseract worker, sequential pages, staged progress |
| `src/lib/ocr/cleanup.ts` | Turns OCR output back into prose — **heavily commented, start here** |
| `src/lib/text/tokenize.ts` | Words and sentences with character offsets |
| `src/lib/tts/types.ts` | The swappable speech interface |
| `src/lib/player.ts` | Chunking, seeking, and the fallback word-timing estimator |
| `src/components/Reader.tsx` | Highlighting, tap-to-seek, auto-scroll |

### OCR cleanup

Raw OCR of a book page is visually faithful and therefore terrible to listen to:
every printed line ends in a hard break, words are split across lines, and the
running header sits in the middle of the prose. `cleanup.ts` fixes the
structure — running heads, page numbers, de-hyphenation, and un-wrapping lines
back into paragraphs (using line *width*, which is the signal that actually
works on justified text).

It deliberately does **not** try to correct words against a dictionary: an OCR
error you can hear beats a confident wrong guess you can't, and the text is
editable anyway. Every switch is exposed in the editor, and every removed line
is listed so nothing disappears silently.

### Text to speech

The default is the browser's **Web Speech API**: free, offline, no key, and its
`boundary` events are what make word highlighting exact rather than guessed.

Everything above `TtsEngine` (player, highlighter, controls) knows only that
interface — `speak(text)`, `onWordBoundary`, `pause`/`resume`/`stop`,
`setRate`. Dropping in a natural cloud voice is one new file.
`src/lib/tts/cloud.ts` is a filled-in stub covering where the API key goes,
how each provider exposes word timings (ElevenLabs and Azure do, OpenAI
doesn't), and what it costs.

**On speed:** the slider stops at whatever the current engine genuinely
honours, and says so. Web Speech ignores rates above about 3×, so it caps at 3×
rather than shipping a 5× control that does nothing. A cloud voice returns an
audio file, where `HTMLAudioElement.playbackRate` really does 5× — that engine
declares `maxRate = 5` and the slider extends itself.

**When a voice reports no word boundaries** — Chrome's network "Google …"
voices and several iOS voices — the player detects it within a sentence and
switches to estimated word timings. Because playback is chunked by sentence,
drift resets at every sentence boundary, so the highlight stays close. The
controls say "highlighting estimated for this voice" when this is in effect.

### Storage

IndexedDB (`src/lib/db/idb.ts`, ~120 lines, no dependency) holds the text, a
page thumbnail, the cleanup settings, the raw per-page OCR text — so cleanup
options can be changed later without re-scanning — and the playback position.
The position is saved during playback and flushed when you leave the reader;
resume re-anchors by character offset if you edited the text in between.

## Deliberate choices

- **No backend.** Ask before adding one — the only feature that genuinely needs
  a server is a cloud voice with a key you don't want in the browser.
- **Dependencies:** React, Tesseract.js, pdf.js, Tailwind. Icons, the IndexedDB
  wrapper, and the test runner are hand-rolled rather than pulled in.
- **pdf.js and Tesseract load on demand**, so opening the library to resume a
  chapter doesn't download an OCR stack. Initial bundle is ~76 kB gzipped.
- **Side files are self-hosted** (`scripts/copy-assets.mjs`) rather than fetched
  from a CDN mid-scan.

## Known limits

- Word highlighting is only as good as the voice: engines that don't report
  boundaries get estimated timings (see above).
- Tapping a word seeks, but the reading surface isn't keyboard-navigable
  word by word; space and the arrow keys drive playback instead.
- English only, because that's the only language data vendored. Tesseract
  supports many more — add them in `scripts/copy-assets.mjs` and pass the codes
  to `createWorker` in `src/lib/ocr/ocr.ts`.
- No browser-back integration: back leaves the app rather than the screen.

## Not built (say the word)

Cloud OCR fallback for messy photos · MP3 export of the narration · batch
scanning a whole chapter.
