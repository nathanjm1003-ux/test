/** Library state: the saved documents, loaded once and kept in sync. */

import { useCallback, useEffect, useState } from 'react';
import * as db from '../lib/db/idb';
import type { Doc, PlaybackPosition } from '../types';

export function useLibrary() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDocs(await db.listDocs());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (doc: Doc) => {
    // Optimistic: the library should update the moment the user saves, even if
    // the write is slow (a big thumbnail on a slow phone).
    setDocs((current) => {
      const rest = current.filter((d) => d.id !== doc.id);
      return [doc, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    try {
      await db.putDoc(doc);
      setError(null);
    } catch (err) {
      setError(`Could not save: ${(err as Error).message}`);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setDocs((current) => current.filter((d) => d.id !== id));
    try {
      await db.deleteDoc(id);
    } catch (err) {
      setError(`Could not delete: ${(err as Error).message}`);
    }
  }, []);

  /** Called frequently during playback — keep it cheap and non-blocking. */
  const savePosition = useCallback((id: string, position: PlaybackPosition) => {
    setDocs((current) =>
      current.map((d) => (d.id === id ? { ...d, position, updatedAt: Date.now() } : d)),
    );
    void db.savePosition(id, position).catch(() => {
      /* a lost position update is not worth interrupting playback for */
    });
  }, []);

  return { docs, loading, error, refresh, save, remove, savePosition };
}
