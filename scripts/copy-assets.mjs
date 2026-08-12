/**
 * Vendors the runtime side files that pdf.js and Tesseract.js fetch over the
 * network instead of bundling, so the app doesn't depend on a third-party CDN
 * being reachable while someone is scanning a page.
 *
 *   public/pdfjs/cmaps          character maps for exotic PDF encodings
 *   public/pdfjs/standard_fonts the 14 base PDF fonts
 *   public/pdfjs/wasm           JBIG2 + JPEG2000 decoders (scanned PDFs)
 *   public/tesseract/           the OCR web worker and the WASM engine
 *   public/tesseract/lang/      the English training data (downloaded)
 *
 * Everything except the language data comes straight from node_modules, so the
 * copy is deterministic and offline. The language data is not published to npm,
 * so it is fetched once — and if that fetch fails the app simply falls back to
 * Tesseract's CDN at runtime, which is why this script never fails the build.
 *
 * Runs from `predev` / `prebuild`. The output is git-ignored.
 */

import { cp, mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');
const publicDir = join(root, 'public');

// --- pdf.js ----------------------------------------------------------------
const pdfOut = join(publicDir, 'pdfjs');
await mkdir(pdfOut, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(join(modules, 'pdfjs-dist', dir), join(pdfOut, dir), { recursive: true });
}

// --- tesseract.js ----------------------------------------------------------
const tessOut = join(publicDir, 'tesseract');
await mkdir(join(tessOut, 'lang'), { recursive: true });

await cp(
  join(modules, 'tesseract.js', 'dist', 'worker.min.js'),
  join(tessOut, 'worker.min.js'),
);
// The core ships four builds: {SIMD, plain} x {full, LSTM-only}. Tesseract
// picks one at runtime from this directory based on the CPU. We only ever run
// OEM 1 (LSTM), so the two full builds — 16 MB of the 30 MB — are dead weight.
const CORE_FILES = [
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
];
for (const file of CORE_FILES) {
  await cp(join(modules, 'tesseract.js-core', file), join(tessOut, file));
}

// --- English training data (best effort) -----------------------------------
const LANG_URL =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const langFile = join(tessOut, 'lang', 'eng.traineddata.gz');

try {
  await access(langFile);
  console.log('assets: language data already vendored');
} catch {
  try {
    const res = await fetch(LANG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(langFile, Buffer.from(await res.arrayBuffer()));
    console.log('assets: downloaded eng.traineddata.gz');
  } catch (err) {
    console.warn(
      `assets: could not vendor the OCR language data (${err.message}). ` +
        'The app will fall back to the Tesseract CDN on first scan.',
    );
  }
}

console.log('assets: ready');
