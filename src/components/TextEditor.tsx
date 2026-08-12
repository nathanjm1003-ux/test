/**
 * Step 3: show the extracted text so the user can fix OCR mistakes before
 * listening, with the cleanup switches exposed rather than hidden — if the
 * un-wrapper guesses wrong on an unusual layout, the user can turn it off and
 * see the raw lines instead.
 */

import { useMemo, useState } from 'react';
import { Button, Card, BackIcon, IconButton, SpeakerIcon } from './ui';
import type { CleanupOptions, CleanupReport } from '../lib/ocr/cleanup';
import type { RawPage } from '../types';

interface Props {
  title: string;
  onTitleChange: (t: string) => void;
  text: string;
  onTextChange: (t: string) => void;
  pages: RawPage[];
  report: CleanupReport;
  options: CleanupOptions;
  onOptionsChange: (o: CleanupOptions) => void;
  onBack: () => void;
  onListen: () => void;
  /** True once the user has typed — re-running cleanup would discard that. */
  dirty: boolean;
}

const OPTION_LABELS: { key: keyof CleanupOptions; label: string; hint: string }[] = [
  {
    key: 'unwrapLines',
    label: 'Join wrapped lines',
    hint: 'Turn printed line breaks back into flowing paragraphs',
  },
  {
    key: 'joinHyphenation',
    label: 'Repair split words',
    hint: '“walk-” + “ing” → “walking”',
  },
  {
    key: 'removePageNumbers',
    label: 'Drop page numbers',
    hint: 'Removes a lone number at the top or bottom of a page',
  },
  {
    key: 'removeRunningHeads',
    label: 'Drop running headers',
    hint: 'Removes the chapter/book title repeated on every page',
  },
];

/** Rough listening time: TTS at 1× lands close to 150 words per minute. */
function estimateMinutes(words: number): string {
  const mins = words / 150;
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `about ${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `about ${h}h ${m}m`;
}

export function TextEditor(props: Props) {
  const { text, report, pages, options } = props;
  const [showRaw, setShowRaw] = useState(false);

  const words = useMemo(
    () => (text.trim() ? text.trim().split(/\s+/).length : 0),
    [text],
  );

  const lowConfidence = pages.filter(
    (p) => p.confidence !== undefined && p.confidence < 65,
  );

  const toggle = (key: keyof CleanupOptions) => {
    if (
      props.dirty &&
      !confirm('Re-running cleanup will discard your edits to the text. Continue?')
    )
      return;
    props.onOptionsChange({ ...options, [key]: !options[key] });
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-32">
      <header className="sticky top-0 z-10 -mx-4 flex items-center gap-2 border-b border-border bg-bg/95 px-4 py-3 backdrop-blur safe-top">
        <IconButton label="Back" onClick={props.onBack}>
          <BackIcon />
        </IconButton>
        <input
          value={props.title}
          onChange={(e) => props.onTitleChange(e.target.value)}
          placeholder="Untitled document"
          aria-label="Document title"
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1.5 text-base font-semibold outline-none focus:bg-surface-2"
        />
        <Button variant="primary" onClick={props.onListen} disabled={!text.trim()}>
          <SpeakerIcon /> Listen
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-xs text-ink-faint">
        <span>
          {pages.length} page{pages.length === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{words.toLocaleString()} words</span>
        <span>·</span>
        <span>{estimateMinutes(words)} at 1×</span>
        {report.removed.length > 0 && (
          <>
            <span>·</span>
            <span>{report.removed.length} artifacts removed</span>
          </>
        )}
        {report.hyphensJoined > 0 && (
          <>
            <span>·</span>
            <span>{report.hyphensJoined} split words repaired</span>
          </>
        )}
      </div>

      {lowConfidence.length > 0 && (
        <Card className="mb-3 !border-danger/40 !bg-danger/5">
          <p className="text-sm text-ink">
            {lowConfidence.length} page{lowConfidence.length === 1 ? '' : 's'} scanned
            with low confidence — check the text below. Better light, a flatter page
            and holding the camera square usually fixes it.
          </p>
        </Card>
      )}

      <textarea
        value={text}
        onChange={(e) => props.onTextChange(e.target.value)}
        spellCheck
        aria-label="Extracted text"
        className="min-h-[45vh] w-full resize-y rounded-2xl border border-border bg-surface p-4 font-reader text-[17px] leading-relaxed outline-none focus:border-accent"
      />

      <details className="mt-4 rounded-2xl border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium select-none">
          Cleanup settings
        </summary>
        <div className="mt-3 space-y-3">
          {OPTION_LABELS.map(({ key, label, hint }) => (
            <label key={key} className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={options[key]}
                onChange={() => toggle(key)}
                className="mt-0.5 h-4 w-4 accent-[var(--c-accent)]"
              />
              <span>
                <span className="block text-sm">{label}</span>
                <span className="block text-xs text-ink-faint">{hint}</span>
              </span>
            </label>
          ))}

          {report.removed.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="text-xs text-accent hover:underline"
              >
                {showRaw ? 'Hide' : 'Show'} the {report.removed.length} removed lines
              </button>
              {showRaw && (
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded-xl bg-surface-2 p-3 text-xs text-ink-soft">
                  {report.removed.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 text-ink-faint">[{r.reason}]</span>
                      <span className="truncate font-mono">{r.line}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
