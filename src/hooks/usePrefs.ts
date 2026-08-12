/**
 * App-wide preferences (theme, text size, last voice and speed), kept in
 * localStorage. Per-document state — the playback position — lives in
 * IndexedDB with the document itself.
 */

import { useCallback, useEffect, useState } from 'react';

export interface Prefs {
  theme: 'dark' | 'light';
  fontSize: number;
  rate: number;
  voiceId: string | null;
  engineId: string;
}

const KEY = 'page-to-voice:prefs';

const DEFAULTS: Prefs = {
  theme: 'dark',
  fontSize: 19,
  rate: 1,
  voiceId: null,
  engineId: 'web-speech',
};

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(read);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode / quota — preferences just won't persist */
    }
    document.documentElement.dataset.theme = prefs.theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', prefs.theme === 'dark' ? '#0b1020' : '#f4f1ea');
  }, [prefs]);

  const update = useCallback(
    (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })),
    [],
  );

  return [prefs, update] as const;
}
