/** The list of swappable speech engines. Add a provider by adding it here. */

import { CloudTtsEngine } from './cloud';
import type { TtsEngine } from './types';
import { WebSpeechEngine } from './webSpeech';

const ALL: TtsEngine[] = [new WebSpeechEngine(), new CloudTtsEngine()];

/** Engines usable right now (the cloud stub hides itself without a key). */
export function availableEngines(): TtsEngine[] {
  return ALL.filter((e) => e.isAvailable());
}

export function getEngine(id: string | undefined): TtsEngine {
  return availableEngines().find((e) => e.id === id) ?? availableEngines()[0] ?? ALL[0];
}

/**
 * Pick a sensible default voice: prefer the platform default if it matches the
 * document language, then any on-device English voice (on-device voices are
 * the ones that emit word boundaries), then whatever exists.
 */
export function pickDefaultVoice(
  voices: { id: string; lang: string; local: boolean; isDefault?: boolean }[],
  lang = 'en',
): string | null {
  if (!voices.length) return null;
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const pool = matching.length ? matching : voices;
  return (
    pool.find((v) => v.isDefault && v.local)?.id ??
    pool.find((v) => v.local)?.id ??
    pool.find((v) => v.isDefault)?.id ??
    pool[0].id
  );
}
