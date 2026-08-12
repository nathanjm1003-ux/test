/**
 * PDF import.
 *
 * A PDF is either "digital" (it carries a real text layer — an ebook, an
 * export from a word processor) or "scanned" (each page is just a photo).
 * We check page by page: if the text layer has enough characters we take it
 * verbatim, which is both instant and perfectly accurate. Only pages without
 * one get rendered to a canvas and pushed through OCR.
 */

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Vite's deploy base, so the app still works when hosted under a sub-path. */
const BASE = import.meta.env.BASE_URL;

/** Below this many characters a "text layer" is really just stray metadata. */
const MIN_TEXT_LAYER_CHARS = 60;
/** Render scale for scanned pages; ~2x gives roughly 144dpi -> good for OCR. */
const OCR_RENDER_SCALE = 2.2;

export interface PdfPage {
  pageNumber: number;
  /** Present when the page had a usable text layer. */
  text?: string;
  /** Present when the page must be OCR'd. */
  canvas?: HTMLCanvasElement;
}

export interface PdfExtractProgress {
  pageNumber: number;
  pageCount: number;
}

/**
 * Rebuild line structure from the text layer.
 *
 * pdf.js gives us positioned runs, not lines. `hasEOL` marks the end of a
 * visual line, which is exactly the signal the cleanup module wants: it can
 * then decide which of those breaks are real paragraph ends.
 */
function itemsToText(items: (TextItem | { type?: string })[]): string {
  let out = '';
  for (const item of items) {
    if (!('str' in item)) continue; // marked-content boundary, not text
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out;
}

async function renderPageToCanvas(
  page: pdfjs.PDFPageProxy,
): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const canvasContext = canvas.getContext('2d', { willReadFrequently: true });
  if (!canvasContext) throw new Error('Canvas 2D is unavailable in this browser.');

  // White background: PDF pages are transparent, and OCR on black-on-transparent
  // (which composites to black-on-black) returns nothing.
  canvasContext.fillStyle = '#ffffff';
  canvasContext.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext, canvas, viewport }).promise;
  return canvas;
}

/** Extract every page of a PDF, choosing text-layer or render-for-OCR per page. */
export async function extractPdf(
  file: File,
  onProgress?: (p: PdfExtractProgress) => void,
  signal?: AbortSignal,
): Promise<PdfPage[]> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Side files copied into public/pdfjs by scripts/copy-pdfjs-assets.mjs.
    // JBIG2 (wasm) in particular is what most scanned PDFs are compressed with.
    cMapUrl: `${BASE}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
    wasmUrl: `${BASE}pdfjs/wasm/`,
  });
  const doc = await loadingTask.promise;

  const pages: PdfPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      onProgress?.({ pageNumber: n, pageCount: doc.numPages });

      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const text = itemsToText(content.items);

        if (text.replace(/\s/g, '').length >= MIN_TEXT_LAYER_CHARS) {
          pages.push({ pageNumber: n, text });
        } else {
          pages.push({ pageNumber: n, canvas: await renderPageToCanvas(page) });
        }
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  return pages;
}
