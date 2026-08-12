/**
 * The artifact's stand-in for the camera screen: paste text, or load a
 * simulated scan. Everything downstream — cleanup, editor, playback,
 * highlighting, library — is the app's real code.
 */

import { useState } from 'react';
import { Button, Card, FileIcon, ImageIcon } from '../src/components/ui';

interface Props {
  onSample: () => void;
  onPaste: (text: string) => void;
  onCancel: () => void;
}

export function AddText({ onSample, onPaste, onCancel }: Props) {
  const [text, setText] = useState('');

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-32">
      <header className="flex items-center justify-between py-4 safe-top">
        <h1 className="text-lg font-semibold">New document</h1>
        <button onClick={onCancel} className="text-sm text-ink-soft hover:text-ink">
          Cancel
        </button>
      </header>

      <Card className="mb-4 !border-accent/30 !bg-accent/5">
        <div className="flex gap-3">
          <ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="space-y-1.5 text-sm">
            <p className="font-medium">Camera and PDF import are off in this preview</p>
            <p className="text-ink-soft">
              OCR needs a 4 MB recognition engine and PDF import a 1.3 MB parser,
              and a published page can’t fetch either. Run the app from the repo
              for the full flow — photograph a page and it lands in the same
              editor you get below.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          onClick={onSample}
          className="rounded-2xl border border-border bg-surface p-4 text-left transition hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <FileIcon className="mb-2 h-5 w-5 text-accent" />
          <p className="font-medium">Load a scanned page</p>
          <p className="mt-1 text-xs text-ink-soft">
            Three pages of Moby-Dick as OCR returns them — running heads, page
            numbers, words split across lines. Cleanup runs for real.
          </p>
        </button>

        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="font-medium">Or paste your own</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste any text to hear it read aloud…"
            aria-label="Text to read"
            className="mt-2 h-24 w-full resize-y rounded-xl border border-border bg-surface-2 p-2.5 text-sm outline-none focus:border-accent"
          />
          <Button
            variant="primary"
            full
            className="mt-2"
            disabled={!text.trim()}
            onClick={() => onPaste(text)}
          >
            Use this text
          </Button>
        </div>
      </div>
    </div>
  );
}
