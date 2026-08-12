/** Shared domain types. */

import type { CleanupOptions } from './lib/ocr/cleanup';

/** How the text for a page was obtained. */
export type PageSource = 'image' | 'pdf-text' | 'pdf-ocr';

/** One scanned/imported page, before cleanup and merging. */
export interface RawPage {
  id: string;
  /** Display name, e.g. "IMG_0421.jpg" or "chapter3.pdf p.2". */
  label: string;
  source: PageSource;
  /** Text exactly as produced by OCR / the PDF text layer. */
  text: string;
  /** OCR confidence 0-100 when available (pdf text layer has none). */
  confidence?: number;
}

/** Where the listener stopped. Stored per document so we can resume. */
export interface PlaybackPosition {
  /** Index into the document's token list (see lib/text/tokenize). */
  tokenIndex: number;
  /** Character offset of that token — used to re-anchor if the text is edited. */
  charIndex: number;
  updatedAt: number;
}

export interface DocSettings {
  engineId: string;
  voiceId: string | null;
  rate: number;
}

/** A saved document in the library. */
export interface Doc {
  id: string;
  title: string;
  /** The text as the user last left it: cleaned, and possibly hand-edited. */
  text: string;
  createdAt: number;
  updatedAt: number;
  pageCount: number;
  /** Small JPEG data URL of the first page, for the library grid. */
  thumbnail?: string;
  position: PlaybackPosition;
  settings: Partial<DocSettings>;
  /**
   * Raw per-page OCR output, kept so cleanup options can be changed later
   * without re-scanning the pages. Dropped for documents imported as text.
   */
  pages?: RawPage[];
  cleanupOptions?: CleanupOptions;
}
