/**
 * In-browser OCR via Tesseract.js.
 *
 * Everything runs client-side in a Web Worker: no server, no upload, no key.
 * The one-time cost is a ~4 MB download (WASM core + English language data) on
 * first use, which the browser then caches. We keep a single worker alive for
 * the whole session so the second document starts instantly.
 */

import { createWorker, PSM, type Worker } from 'tesseract.js';

export interface OcrProgress {
  /** Human-readable stage, e.g. "Recognising text". */
  stage: string;
  /** 0-based index of the page being worked on. */
  pageIndex: number;
  pageCount: number;
  /** 0..1 within the current page. */
  pageProgress: number;
  /** 0..1 across the whole batch. */
  overall: number;
}

export interface OcrPageResult {
  text: string;
  /** Mean recogniser confidence, 0-100. Low values flag a bad photo. */
  confidence: number;
}

/** Tesseract's internal status strings are terse; map the ones users see. */
const STAGE_LABELS: Record<string, string> = {
  'loading tesseract core': 'Loading OCR engine',
  'initializing tesseract': 'Starting OCR engine',
  'loading language traineddata': 'Loading language data',
  'initializing api': 'Preparing',
  'recognizing text': 'Reading page',
};

let workerPromise: Promise<Worker> | null = null;
/** Set by the active batch so the shared worker's logger can report progress. */
let activeLogger: ((status: string, progress: number) => void) | null = null;

/**
 * Absolute URLs for the self-hosted engine (see scripts/copy-assets.mjs).
 * Absolute rather than relative because Tesseract loads its worker through a
 * Blob URL, where a relative path would resolve against the wrong base.
 */
const local = (path: string) =>
  new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href;

async function spawn(selfHosted: boolean): Promise<Worker> {
  const worker = await createWorker(
    'eng',
    1,
    selfHosted
      ? {
          logger: (m) => activeLogger?.(m.status, m.progress),
          workerPath: local('tesseract/worker.min.js'),
          corePath: local('tesseract/'),
          langPath: local('tesseract/lang'),
        }
      : // Fall back to Tesseract's own CDN, which is its default.
        { logger: (m) => activeLogger?.(m.status, m.progress) },
  );
  // PSM.AUTO handles a single column of prose, which is what a book page is.
  // SINGLE_BLOCK does worse on pages with a drop cap or an epigraph.
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: '1',
  });
  return worker;
}

/**
 * Is the vendored engine actually there?
 *
 * scripts/copy-assets.mjs downloads the language data on a best-effort basis,
 * so it may be absent. We check with one HEAD request rather than letting
 * `createWorker` fail and retrying: a failed Tesseract init leaves its internal
 * job registry in a state where the *next* attempt throws something unrelated.
 */
let vendored: Promise<boolean> | null = null;
function hasVendoredEngine(): Promise<boolean> {
  vendored ??= fetch(local('tesseract/lang/eng.traineddata.gz'), { method: 'HEAD' })
    .then((res) => res.ok)
    .catch(() => false);
  return vendored;
}

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const selfHosted = await hasVendoredEngine();
      if (!selfHosted) {
        console.info(
          'OCR language data is not vendored locally; using the Tesseract CDN. ' +
            'Run `npm run build` with a network connection to make OCR work offline.',
        );
      }
      return spawn(selfHosted);
    })().catch((err: unknown) => {
      workerPromise = null; // let the next attempt retry from scratch
      throw new Error(
        'Could not start the OCR engine. It needs to download about 4 MB the ' +
          `first time — check your connection and try again. (${(err as Error).message})`,
      );
    });
  }
  return workerPromise;
}

/** Warm the engine up (e.g. while the user is still picking files). */
export function warmUpOcr(): void {
  void getWorker().catch(() => {
    /* surfaced later, on the real call */
  });
}

/**
 * Recognise a batch of prepared page images, sequentially.
 *
 * Sequential rather than parallel on purpose: a second worker means a second
 * copy of the WASM core and language data in memory, which phones do not
 * appreciate, and Tesseract is already CPU-bound.
 */
export async function recognizePages(
  canvases: HTMLCanvasElement[],
  onProgress: (p: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<OcrPageResult[]> {
  const worker = await getWorker();
  const results: OcrPageResult[] = [];
  const pageCount = canvases.length;

  for (let i = 0; i < pageCount; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    activeLogger = (status, progress) => {
      const stage = STAGE_LABELS[status] ?? status;
      onProgress({
        stage,
        pageIndex: i,
        pageCount,
        pageProgress: progress,
        overall: (i + progress) / pageCount,
      });
    };

    try {
      const { data } = await worker.recognize(canvases[i]);
      results.push({ text: data.text ?? '', confidence: data.confidence ?? 0 });
    } finally {
      activeLogger = null;
    }
  }

  onProgress({
    stage: 'Done',
    pageIndex: pageCount - 1,
    pageCount,
    pageProgress: 1,
    overall: 1,
  });
  return results;
}

/** Free the worker and its ~4 MB of WASM. Safe to call when idle. */
export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try {
    (await p).terminate();
  } catch {
    /* already gone */
  }
}
