/** Step 1: pick pages — camera, image files, or a PDF. */

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  CameraIcon,
  Card,
  CloseIcon,
  FileIcon,
  ImageIcon,
} from './ui';

export interface PickedFile {
  id: string;
  file: File;
  /** Object URL for the preview thumbnail (images only). */
  preview?: string;
}

interface Props {
  files: PickedFile[];
  onChange: (files: PickedFile[]) => void;
  onExtract: () => void;
  onCancel?: () => void;
}

/** A PDF can hold many pages, so count files here, not pages. */
const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} kB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const makePicked = (file: File): PickedFile => ({
  id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
  file,
  preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
});

export function Capture({ files, onChange, onExtract, onCancel }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Object URLs are a leak if we never revoke them.
  useEffect(() => {
    return () => {
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    };
    // Intentionally on unmount only — removal revokes individually below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = (list: FileList | File[] | null) => {
    if (!list) return;
    const accepted = Array.from(list).filter(
      (f) => f.type.startsWith('image/') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name),
    );
    if (accepted.length) onChange([...files, ...accepted.map(makePicked)]);
  };

  const remove = (id: string) => {
    const target = files.find((f) => f.id === id);
    if (target?.preview) URL.revokeObjectURL(target.preview);
    onChange(files.filter((f) => f.id !== id));
  };

  const move = (index: number, delta: number) => {
    const next = [...files];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-32">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-lg font-semibold">New document</h1>
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-sm text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
        )}
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed p-5 transition ${
          dragging ? 'border-accent bg-surface-2' : 'border-border bg-surface'
        }`}
      >
        <div className="grid gap-2.5 sm:grid-cols-3">
          <Button variant="primary" onClick={() => cameraRef.current?.click()}>
            <CameraIcon /> Take photo
          </Button>
          <Button onClick={() => imageRef.current?.click()}>
            <ImageIcon /> Add images
          </Button>
          <Button onClick={() => pdfRef.current?.click()}>
            <FileIcon /> Add PDF
          </Button>
        </div>
        <p className="mt-3 text-center text-xs text-ink-faint">
          Photograph one page at a time, or drop several images / a PDF here.
          Everything stays on your device.
        </p>
      </div>

      {/* Hidden inputs. `capture` opens the rear camera straight away on phones. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={pdfRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />

      {files.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2 text-sm font-medium text-ink-soft">
            {files.length} file{files.length === 1 ? '' : 's'} — they will be read in this order
          </h2>
          <ul className="space-y-2">
            {files.map((f, i) => (
              <li key={f.id}>
                <Card className="flex items-center gap-3 !p-2.5">
                  <div className="flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2">
                    {f.preview ? (
                      <img
                        src={f.preview}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <FileIcon className="h-5 w-5 text-ink-faint" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{f.file.name}</p>
                    <p className="text-xs text-ink-faint">
                      {formatSize(f.file.size)}
                      {f.file.type === 'application/pdf' && ' · all pages'}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="rounded-lg px-2 py-1 text-ink-soft hover:bg-surface-2 disabled:opacity-25"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={i === files.length - 1}
                      aria-label="Move down"
                      className="rounded-lg px-2 py-1 text-ink-soft hover:bg-surface-2 disabled:opacity-25"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => remove(f.id)}
                      aria-label={`Remove ${f.file.name}`}
                      className="rounded-lg p-1.5 text-ink-soft hover:bg-surface-2 hover:text-danger"
                    >
                      <CloseIcon className="h-4 w-4" />
                    </button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg/95 px-4 pt-3 backdrop-blur safe-bottom">
          <div className="mx-auto max-w-2xl">
            <Button variant="primary" full onClick={onExtract}>
              Extract text from {files.length} file{files.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
