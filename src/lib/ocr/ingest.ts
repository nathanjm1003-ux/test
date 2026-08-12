/**
 * Ingest pipeline: files in, clean readable text out.
 *
 *   files -> [decode/render] -> page images or text-layer text
 *         -> [Tesseract]     -> raw per-page text
 *         -> [cleanup]       -> one document
 *
 * Pages keep the order the user picked them in, and a PDF expands in place
 * into its own pages, so a mixed selection (cover photo + chapter PDF) still
 * reads in the right order.
 */

import { uid } from '../id';
import { cleanPages, type CleanupOptions, type CleanupReport } from './cleanup';
import { prepareImage, makeThumbnail } from './imagePrep';
import type { RawPage } from '../../types';

/*
 * pdf.js (~1.3 MB) and Tesseract's engine are loaded on demand rather than in
 * the main bundle: someone opening their library to resume a chapter should
 * not pay to download an OCR stack they aren't using.
 */

export type IngestPhase = 'preparing' | 'reading-pdf' | 'ocr' | 'cleaning';

export interface IngestProgress {
  phase: IngestPhase;
  /** Sentence shown under the progress bar. */
  label: string;
  /** 0..1 for the whole ingest. */
  progress: number;
}

export interface IngestResult {
  pages: RawPage[];
  /** Cleaned, merged text ready for the editor. */
  text: string;
  report: CleanupReport;
  thumbnail?: string;
}

/** One page waiting to be turned into text. */
interface PendingPage {
  label: string;
  canvas?: HTMLCanvasElement;
  text?: string;
  thumbnail?: string;
}

const isPdf = (f: File) =>
  f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/**
 * Weights for the progress bar. OCR dominates wall-clock time by a wide margin
 * (seconds per page vs milliseconds for decoding), so give it most of the bar.
 */
const PREP_SHARE = 0.15;

export async function ingestFiles(
  files: File[],
  onProgress: (p: IngestProgress) => void,
  options?: Partial<CleanupOptions>,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const pending: PendingPage[] = [];

  // --- Phase A: decode images / expand PDFs --------------------------------
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const file = files[i];
    const fileShare = (i / files.length) * PREP_SHARE;

    if (isPdf(file)) {
      const { extractPdf } = await import('./pdf');
      const pdfPages = await extractPdf(
        file,
        ({ pageNumber, pageCount }) =>
          onProgress({
            phase: 'reading-pdf',
            label: `Reading ${file.name} — page ${pageNumber} of ${pageCount}`,
            progress: fileShare + (pageNumber / pageCount) * (PREP_SHARE / files.length),
          }),
        signal,
      );
      for (const p of pdfPages) {
        pending.push({
          label: `${file.name} p.${p.pageNumber}`,
          text: p.text,
          canvas: p.canvas,
          thumbnail: p.canvas ? makeThumbnail(p.canvas) : undefined,
        });
      }
    } else {
      onProgress({
        phase: 'preparing',
        label: `Preparing ${file.name}`,
        progress: fileShare,
      });
      const prepared = await prepareImage(file);
      pending.push({
        label: file.name,
        canvas: prepared.canvas,
        thumbnail: prepared.thumbnail,
      });
    }
  }

  if (!pending.length) throw new Error('No readable pages were found in that selection.');

  // --- Phase B: OCR the pages that need it ---------------------------------
  const needOcr = pending.filter((p) => p.canvas && p.text === undefined);
  if (needOcr.length) {
    const { recognizePages } = await import('./ocr');
    const results = await recognizePages(
      needOcr.map((p) => p.canvas!),
      (p) =>
        onProgress({
          phase: 'ocr',
          label:
            p.stage === 'Reading page'
              ? `Reading page ${p.pageIndex + 1} of ${p.pageCount}`
              : p.stage,
          progress: PREP_SHARE + p.overall * (1 - PREP_SHARE - 0.05),
        }),
      signal,
    );
    needOcr.forEach((page, i) => {
      page.text = results[i].text;
      (page as PendingPage & { confidence?: number }).confidence = results[i].confidence;
    });
  }

  // --- Phase C: clean up ----------------------------------------------------
  onProgress({ phase: 'cleaning', label: 'Tidying up the text', progress: 0.97 });

  const pages: RawPage[] = pending.map((p) => ({
    id: uid('pg'),
    label: p.label,
    source: p.canvas ? (p.label.includes(' p.') ? 'pdf-ocr' : 'image') : 'pdf-text',
    text: p.text ?? '',
    confidence: (p as PendingPage & { confidence?: number }).confidence,
  }));

  const { text, report } = cleanPages(
    pages.map((p) => p.text),
    options,
  );

  onProgress({ phase: 'cleaning', label: 'Done', progress: 1 });

  return { pages, text, report, thumbnail: pending.find((p) => p.thumbnail)?.thumbnail };
}

/**
 * Re-run cleanup on already-OCR'd pages. Used when the user toggles a cleanup
 * option in the editor — no need to OCR again.
 */
export function recleanPages(
  pages: RawPage[],
  options?: Partial<CleanupOptions>,
): { text: string; report: CleanupReport } {
  return cleanPages(
    pages.map((p) => p.text),
    options,
  );
}

/** First non-empty line, trimmed — a decent default document title. */
export function guessTitle(text: string, fallback: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 2);
  if (!line) return fallback;
  const words = line.split(/\s+/).slice(0, 8).join(' ');
  return words.length > 60 ? `${words.slice(0, 57)}...` : words;
}
