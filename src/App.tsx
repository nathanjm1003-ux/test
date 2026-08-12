import { useCallback, useEffect, useRef, useState } from 'react';
import { Capture, type PickedFile } from './components/Capture';
import { Library } from './components/Library';
import { Processing } from './components/Processing';
import { ReaderScreen } from './components/ReaderScreen';
import { TextEditor } from './components/TextEditor';
import { useLibrary } from './hooks/useLibrary';
import { usePrefs } from './hooks/usePrefs';
import { uid } from './lib/id';
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
import type { Doc } from './types';

type View = 'library' | 'capture' | 'processing' | 'edit' | 'read';

const EMPTY_PROGRESS: IngestProgress = {
  phase: 'preparing',
  label: 'Starting…',
  progress: 0,
};

const EMPTY_REPORT: CleanupReport = { removed: [], hyphensJoined: 0, linesUnwrapped: 0 };

/** Wait this long after the last keystroke before writing an edit to storage. */
const AUTOSAVE_MS = 1000;

export function App() {
  const [prefs, setPrefs] = usePrefs();
  const library = useLibrary();

  const [view, setView] = useState<View>('library');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [progress, setProgress] = useState<IngestProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);

  /** The document currently being edited or listened to. */
  const [active, setActive] = useState<Doc | null>(null);
  /** Cleanup report for `active` — recomputed on demand rather than stored. */
  const [report, setReport] = useState<CleanupReport>(EMPTY_REPORT);
  /** The user has hand-edited the text since the last cleanup run. */
  const [dirty, setDirty] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const saveTimer = useRef<number | null>(null);

  // --- creating a document --------------------------------------------------

  const startCapture = () => {
    setError(null);
    setFiles([]);
    setView('capture');
    // Start fetching the OCR engine while the user is still picking pages.
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

      const now = Date.now();
      const doc: Doc = {
        id: uid('doc'),
        title: guessTitle(result.text, files[0].file.name.replace(/\.[^.]+$/, '')),
        text: result.text,
        createdAt: now,
        updatedAt: now,
        pageCount: result.pages.length,
        thumbnail: result.thumbnail,
        position: { tokenIndex: 0, charIndex: 0, updatedAt: now },
        settings: { engineId: prefs.engineId, voiceId: prefs.voiceId, rate: prefs.rate },
        pages: result.pages,
        cleanupOptions: defaultCleanupOptions,
      };

      // Saved straight away: OCR is the expensive part, and losing it to a
      // stray back-navigation would be infuriating.
      void library.save(doc);
      setActive(doc);
      setReport(result.report);
      setDirty(false);
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
  }, [files, library, prefs]);

  // --- editing --------------------------------------------------------------

  /** Update the working document and schedule a save. */
  const patchActive = useCallback(
    (patch: Partial<Doc>) => {
      setActive((current) => {
        if (!current) return current;
        const next = { ...current, ...patch, updatedAt: Date.now() };
        if (saveTimer.current !== null) clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => void library.save(next), AUTOSAVE_MS);
        return next;
      });
    },
    [library],
  );

  /** Write any pending edit immediately — called when leaving the editor. */
  const flushSave = useCallback(() => {
    if (saveTimer.current === null) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (active) void library.save(active);
  }, [active, library]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );

  const changeCleanupOptions = (options: CleanupOptions) => {
    if (!active?.pages) return;
    const result = recleanPages(active.pages, options);
    setReport(result.report);
    setDirty(false);
    patchActive({ text: result.text, cleanupOptions: options });
  };

  const openDoc = (doc: Doc) => {
    setActive(doc);
    setReport(doc.pages ? recleanPages(doc.pages, doc.cleanupOptions).report : EMPTY_REPORT);
    setDirty(false);
    setView('read');
  };

  const leaveToLibrary = () => {
    flushSave();
    setActive(null);
    setView('library');
    // Deliberately no re-read from IndexedDB here: the reader saves its final
    // position from its unmount handler, which runs *after* this. A refresh
    // would race that write and show a stale position.
  };

  const errorBanner = error && (
    <div className="mx-auto max-w-2xl px-4 pt-4">
      <p className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
        {error}
      </p>
    </div>
  );

  // --- render ---------------------------------------------------------------

  return (
    <div className="min-h-dvh">
      {view === 'library' && (
        <main>
          {errorBanner}
          <Library
            docs={library.docs}
            loading={library.loading}
            error={library.error}
            onOpen={openDoc}
            onDelete={(id) => void library.remove(id)}
            onNew={startCapture}
          />
        </main>
      )}

      {view === 'capture' && (
        <main>
          {errorBanner}
          <Capture
            files={files}
            onChange={setFiles}
            onExtract={runIngest}
            onCancel={() => setView('library')}
          />
        </main>
      )}

      {view === 'processing' && (
        <Processing progress={progress} onCancel={() => abortRef.current?.abort()} />
      )}

      {view === 'edit' && active && (
        <main>
          <TextEditor
            title={active.title}
            onTitleChange={(title) => patchActive({ title })}
            text={active.text}
            onTextChange={(text) => {
              setDirty(true);
              patchActive({ text });
            }}
            pages={active.pages ?? []}
            report={report}
            options={active.cleanupOptions ?? defaultCleanupOptions}
            onOptionsChange={changeCleanupOptions}
            dirty={dirty}
            onBack={leaveToLibrary}
            onListen={() => {
              flushSave();
              setView('read');
            }}
          />
        </main>
      )}

      {view === 'read' && active && (
        <ReaderScreen
          title={active.title}
          text={active.text}
          position={active.position}
          prefs={prefs}
          onPrefs={setPrefs}
          onBack={leaveToLibrary}
          onEdit={() => setView('edit')}
          onPosition={(position) => {
            setActive((current) => (current ? { ...current, position } : current));
            library.savePosition(active.id, position);
          }}
        />
      )}
    </div>
  );
}
