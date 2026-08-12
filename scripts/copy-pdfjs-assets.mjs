/**
 * pdf.js loads three sets of side files at runtime rather than bundling them:
 *
 *   cmaps/          character maps for PDFs with CJK / exotic encodings
 *   standard_fonts/ the 14 PDF base fonts, for documents that don't embed them
 *   wasm/           JBIG2 + JPEG2000 decoders — scanned PDFs lean on JBIG2
 *
 * They live in node_modules, which the browser can't reach, so copy them into
 * public/ before dev and build. Runs from `predev` / `prebuild`; the copy is
 * git-ignored so we don't vendor ~4 MB of binaries into the repo.
 */

import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pdfjs-dist');
const to = join(root, 'public', 'pdfjs');

await mkdir(to, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(join(from, dir), join(to, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
