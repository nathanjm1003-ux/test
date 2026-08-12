/**
 * The published-preview shell.
 *
 * Same components, same player, same storage as src/App.tsx — only the way
 * text gets in differs, because a sandboxed page can't pull down the OCR
 * engine or the PDF parser. See artifact/AddText.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Library } from '../src/components/Library';
import { ReaderScreen } from '../src/components/ReaderScreen';
import { TextEditor } from '../src/components/TextEditor';
import { useLibrary } from '../src/hooks/useLibrary';
import { usePrefs } from '../src/hooks/usePrefs';
import { uid } from '../src/lib/id';
import {
  cleanPages,
  defaultCleanupOptions,
  type CleanupOptions,
  type CleanupReport,
} from '../src/lib/ocr/cleanup';
import { guessTitle, recleanPages } from '../src/lib/ocr/ingest';
import type { Doc, RawPage } from '../src/types';
import { AddText } from './AddText';
import { SAMPLE_PAGES } from './sample';

type View = 'library' | 'add' | 'edit' | 'read';

const EMPTY_REPORT: CleanupReport = { removed: [], hyphensJoined: 0, linesUnwrapped: 0 };
const AUTOSAVE_MS = 1000;

export function ArtifactApp() {
  const [prefs, setPrefs] = usePrefs();
  const library = useLibrary();

  const [view, setView] = useState<View>('library');
  const [active, setActive] = useState<Doc | null>(null);
  const [report, setReport] = useState<CleanupReport>(EMPTY_REPORT);
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef<number | null>(null);

  const create = (rawPages: string[], fallbackTitle: string) => {
    const { text, report: cleanupReport } = cleanPages(rawPages, defaultCleanupOptions);
    const now = Date.now();
    const pages: RawPage[] = rawPages.map((pageText, i) => ({
      id: uid('pg'),
      label: `page ${i + 1}`,
      source: 'image',
      text: pageText,
    }));

    const doc: Doc = {
      id: uid('doc'),
      title: guessTitle(text, fallbackTitle),
      text,
      createdAt: now,
      updatedAt: now,
      pageCount: pages.length,
      position: { tokenIndex: 0, charIndex: 0, updatedAt: now },
      settings: { engineId: prefs.engineId, voiceId: prefs.voiceId, rate: prefs.rate },
      pages,
      cleanupOptions: defaultCleanupOptions,
    };

    void library.save(doc);
    setActive(doc);
    setReport(cleanupReport);
    setDirty(false);
    setView('edit');
  };

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

  const leaveToLibrary = () => {
    flushSave();
    setActive(null);
    setView('library');
  };

  return (
    <div className="min-h-dvh">
      {view === 'library' && (
        <main>
          <Library
            docs={library.docs}
            loading={library.loading}
            error={library.error}
            onOpen={(doc) => {
              setActive(doc);
              setReport(
                doc.pages ? recleanPages(doc.pages, doc.cleanupOptions).report : EMPTY_REPORT,
              );
              setDirty(false);
              setView('read');
            }}
            onDelete={(id) => void library.remove(id)}
            onNew={() => setView('add')}
            theme={prefs.theme}
            onTheme={(theme) => setPrefs({ theme })}
          />
        </main>
      )}

      {view === 'add' && (
        <main>
          <AddText
            onSample={() => create(SAMPLE_PAGES, 'Moby-Dick')}
            onPaste={(text) => create([text], 'Pasted text')}
            onCancel={() => setView('library')}
          />
        </main>
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
            onOptionsChange={(options: CleanupOptions) => {
              if (!active.pages) return;
              const result = recleanPages(active.pages, options);
              setReport(result.report);
              setDirty(false);
              patchActive({ text: result.text, cleanupOptions: options });
            }}
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
