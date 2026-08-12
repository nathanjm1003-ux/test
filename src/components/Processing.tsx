/** Full-screen progress while OCR runs. */

import { Button, ProgressBar } from './ui';
import type { IngestProgress } from '../lib/ocr/ingest';

export function Processing({
  progress,
  onCancel,
}: {
  progress: IngestProgress;
  onCancel: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="relative flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/20" />
        <span className="relative text-3xl">📖</span>
      </div>

      <div className="w-full space-y-3">
        <ProgressBar value={progress.progress} />
        <p className="text-sm text-ink" aria-live="polite">
          {progress.label}
        </p>
        <p className="text-xs text-ink-faint">
          {progress.phase === 'ocr'
            ? 'Recognising text on your device — no upload, no account.'
            : 'Preparing your pages…'}
        </p>
      </div>

      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
