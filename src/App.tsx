import { useCallback, useRef, useState } from 'react';
import { Capture, type PickedFile } from './components/Capture';
import { ReaderScreen } from './components/ReaderScreen';
import { Processing } from './components/Processing';
import { TextEditor } from './components/TextEditor';
import { Button, LibraryIcon, PlusIcon } from './components/ui';
import {
  defaultCleanupOptions,
  type CleanupOptions,
  type CleanupReport,
} from './lib/ocr/cleanup';
import {
  guessTitle,
  ingestFiles,
  recleanPages,
  type IngestProgress,
} from './lib/ocr/ingest';
import { usePrefs } from './hooks/usePrefs';
import { uid } from './lib/id';
import type { PlaybackPosition, RawPage } from './types';

type View = 'home' | 'capture' | 'processing' | 'edit' | 'read';

/** A document being created, before it is saved to the library. */
interface Draft {
  id: string;
  title: string;
  text: string;
  pages: RawPage[];
  report: CleanupReport;
  thumbnail?: string;
  options: CleanupOptions;
  /** The user has hand-edited the text; re-cleaning would discard it. */
  dirty: boolean;
  position: PlaybackPosition;
}

const EMPTY_PROGRESS: IngestProgress = {
  phase: 'preparing',
  label: 'Starting…',
  progress: 0,
};

export function App() {
  const [prefs, setPrefs] = usePrefs();
  const [view, setView] = useState<View>('home');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [progress, setProgress] = useState<IngestProgress>(EMPTY_PROGRESS);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startCapture = () => {
    setError(null);
    setFiles([]);
    setView('capture');
    // Start downloading the OCR engine while the user is still picking pages.
    void import('./lib/ocr/ocr').then((m) => m.warmUpOcr());
  };

  const runIngest = useCallback(async () => {
    if (!files.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(EMPTY_PROGRESS);
    setError(null);
    setView('processing');

    try {
      const result = await ingestFiles(
        files.map((f) => f.file),
        setProgress,
        defaultCleanupOptions,
        controller.signal,
      );
      setDraft({
        id: uid('doc'),
        title: guessTitle(result.text, files[0].file.name.replace(/\.[^.]+$/, '')),
        text: result.text,
        pages: result.pages,
        report: result.report,
        thumbnail: result.thumbnail,
        options: defaultCleanupOptions,
        dirty: false,
        position: { tokenIndex: 0, charIndex: 0, updatedAt: Date.now() },
      });
      setView('edit');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setView('capture');
        return;
      }
      console.error(err);
      setError(
        (err as Error).message ||
          'Something went wrong while reading those pages. Try again?',
      );
      setView('capture');
    } finally {
      abortRef.current = null;
    }
  }, [files]);

  const changeOptions = (options: CleanupOptions) => {
    if (!draft) return;
    const { text, report } = recleanPages(draft.pages, options);
    setDraft({ ...draft, options, text, report, dirty: false });
  };

  return (
    <div className="min-h-dvh">
      {view === 'home' && (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
          <LibraryIcon className="h-12 w-12 text-ink-faint" />
          <div>
            <h1 className="text-2xl font-semibold">Page to Voice</h1>
            <p className="mt-2 text-sm text-ink-soft">
              Photograph a book page and listen to it, with every word
              highlighted as it is read.
            </p>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button variant="primary" onClick={startCapture}>
            <PlusIcon /> New document
          </Button>
        </main>
      )}

      {view === 'capture' && (
        <main>
          {error && (
            <div className="mx-auto max-w-2xl px-4 pt-4">
              <p className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
                {error}
              </p>
            </div>
          )}
          <Capture
            files={files}
            onChange={setFiles}
            onExtract={runIngest}
            onCancel={() => setView('home')}
          />
        </main>
      )}

      {view === 'processing' && (
        <Processing
          progress={progress}
          onCancel={() => abortRef.current?.abort()}
        />
      )}

      {view === 'edit' && draft && (
        <main>
          <TextEditor
            title={draft.title}
            onTitleChange={(title) => setDraft({ ...draft, title })}
            text={draft.text}
            onTextChange={(text) => setDraft({ ...draft, text, dirty: true })}
            pages={draft.pages}
            report={draft.report}
            options={draft.options}
            onOptionsChange={changeOptions}
            dirty={draft.dirty}
            onBack={() => setView('capture')}
            onListen={() => setView('read')}
          />
        </main>
      )}

      {view === 'read' && draft && (
        <ReaderScreen
          title={draft.title}
          text={draft.text}
          position={draft.position}
          prefs={prefs}
          onPrefs={setPrefs}
          onBack={() => setView('home')}
          onEdit={() => setView('edit')}
          onPosition={(position) =>
            setDraft((d) => (d ? { ...d, position } : d))
          }
        />
      )}
    </div>
  );
}
