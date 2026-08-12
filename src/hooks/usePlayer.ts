/** React binding for the framework-free `Player`. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerState } from '../lib/player';
import { getEngine, pickDefaultVoice } from '../lib/tts/registry';
import type { TtsVoice } from '../lib/tts/types';
import type { Tokenized } from '../lib/text/tokenize';

export interface UsePlayerOptions {
  engineId?: string;
  voiceId?: string | null;
  rate?: number;
  /** Token to start from, e.g. a saved playback position. */
  startToken?: number;
}

export function usePlayer(doc: Tokenized, options: UsePlayerOptions = {}) {
  const [engineId, setEngineId] = useState(options.engineId ?? 'web-speech');
  const engine = useMemo(() => getEngine(engineId), [engineId]);

  // One Player for the lifetime of the reader screen.
  const playerRef = useRef<Player | null>(null);
  if (playerRef.current === null) playerRef.current = new Player(engine);
  const player = playerRef.current;

  const [state, setState] = useState<PlayerState>(player.state);
  const [voices, setVoices] = useState<TtsVoice[]>([]);

  useEffect(() => player.subscribe(setState), [player]);

  // Load the document (and any saved position) whenever it changes.
  useEffect(() => {
    player.setDocument(doc, options.startToken ?? 0);
    // startToken is an initial value only — re-seeking on every render would
    // fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, doc]);

  useEffect(() => {
    if (player.engine !== engine) player.setEngine(engine);
  }, [player, engine]);

  // Voice list for the current engine, plus a sensible default.
  useEffect(() => {
    let cancelled = false;
    void engine.getVoices().then((list) => {
      if (cancelled) return;
      setVoices(list);
      const wanted =
        options.voiceId && list.some((v) => v.id === options.voiceId)
          ? options.voiceId
          : pickDefaultVoice(list);
      player.setVoice(wanted);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, player]);

  useEffect(() => {
    if (options.rate) player.setRate(options.rate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  // Stop speaking when the reader unmounts — otherwise the voice keeps going
  // after the user navigates back to the library.
  useEffect(() => () => player.stop(), [player]);

  return {
    state,
    engine,
    engineId,
    voices,
    setEngineId,
    play: useCallback(() => player.play(), [player]),
    pause: useCallback(() => player.pause(), [player]),
    toggle: useCallback(() => player.toggle(), [player]),
    stop: useCallback(() => player.stop(), [player]),
    next: useCallback(() => player.nextSentence(), [player]),
    previous: useCallback(() => player.previousSentence(), [player]),
    seek: useCallback(
      (tokenIndex: number, autoplay?: boolean) => player.seekToToken(tokenIndex, autoplay),
      [player],
    ),
    setRate: useCallback((rate: number) => player.setRate(rate), [player]),
    setVoice: useCallback((id: string | null) => player.setVoice(id), [player]),
  };
}
