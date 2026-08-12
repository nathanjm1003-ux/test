/** The home screen: saved documents, each resumable where it was left. */

import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  FileIcon,
  IconButton,
  LibraryIcon,
  MoonIcon,
  PlayIcon,
  PlusIcon,
  SunIcon,
  TrashIcon,
} from './ui';
import { storageUsed } from '../lib/db/idb';
import { countWords } from '../lib/text/tokenize';
import type { Doc } from '../types';

interface Props {
  docs: Doc[];
  loading: boolean;
  error: string | null;
  onOpen: (doc: Doc) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  theme: 'dark' | 'light';
  onTheme: (t: 'dark' | 'light') => void;
}

function relativeTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Library({
  docs,
  loading,
  error,
  onOpen,
  onDelete,
  onNew,
  theme,
  onTheme,
}: Props) {
  const [used, setUsed] = useState<number>();
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    void storageUsed().then(setUsed);
  }, [docs.length]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-28">
      <header className="flex items-center justify-between py-5 safe-top">
        <h1 className="text-xl font-semibold">Page to Voice</h1>
        <div className="flex items-center gap-1">
          <IconButton
            label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </IconButton>
          <Button variant="primary" onClick={onNew}>
            <PlusIcon /> New
          </Button>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {loading ? (
        <p className="py-16 text-center text-sm text-ink-faint">Opening your library…</p>
      ) : docs.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <LibraryIcon className="h-12 w-12 text-ink-faint" />
          <div>
            <p className="font-medium">Nothing here yet</p>
            <p className="mt-1 max-w-xs text-sm text-ink-soft">
              Photograph a book page, or drop in a PDF. The text is extracted on
              your device and read aloud with every word highlighted.
            </p>
          </div>
          <Button variant="primary" onClick={onNew}>
            <PlusIcon /> Scan your first page
          </Button>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {docs.map((doc) => {
            const words = countWords(doc.text);
            // The saved position is a token index, so it doubles as progress.
            const progress = words ? Math.min(1, doc.position.tokenIndex / words) : 0;
            const started = doc.position.tokenIndex > 0;

            return (
              <li key={doc.id}>
                <Card className="!p-3">
                  <div className="flex gap-3">
                    <button
                      onClick={() => onOpen(doc)}
                      className="flex h-20 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2"
                      aria-label={`Open ${doc.title}`}
                    >
                      {doc.thumbnail ? (
                        <img src={doc.thumbnail} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <FileIcon className="h-6 w-6 text-ink-faint" />
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => onOpen(doc)}
                        className="block w-full text-left"
                      >
                        <h2 className="truncate font-medium">{doc.title}</h2>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {doc.pageCount} page{doc.pageCount === 1 ? '' : 's'} ·{' '}
                          {words.toLocaleString()} words · {relativeTime(doc.updatedAt)}
                        </p>
                      </button>

                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.round(progress * 100)}%` }}
                          />
                        </div>
                        <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
                          {started ? `${Math.round(progress * 100)}%` : 'not started'}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-center justify-between">
                      <button
                        onClick={() => onOpen(doc)}
                        aria-label={started ? `Resume ${doc.title}` : `Play ${doc.title}`}
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink"
                      >
                        <PlayIcon className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setConfirming(doc.id)}
                        aria-label={`Delete ${doc.title}`}
                        className="rounded-lg p-1.5 text-ink-faint hover:text-danger"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {confirming === doc.id && (
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-surface-2 p-3">
                      <p className="text-sm">Delete “{doc.title}”?</p>
                      <div className="flex shrink-0 gap-2">
                        <Button variant="ghost" onClick={() => setConfirming(null)}>
                          Keep
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            setConfirming(null);
                            onDelete(doc.id);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {docs.length > 0 && used !== undefined && (
        <p className="mt-6 text-center text-[11px] text-ink-faint">
          Stored on this device only · about {formatBytes(used)} used
        </p>
      )}
    </div>
  );
}
