/** Listening view: header, highlighted document, transport bar. */

import { useEffect, useMemo, useRef } from 'react';
import { PlayerControls } from './PlayerControls';
import { Reader } from './Reader';
import { BackIcon, IconButton, PencilIcon } from './ui';
import { usePlayer } from '../hooks/usePlayer';
import { tokenize } from '../lib/text/tokenize';
import { availableEngines } from '../lib/tts/registry';
import type { Prefs } from '../hooks/usePrefs';
import type { PlaybackPosition } from '../types';

interface Props {
  title: string;
  text: string;
  /** Saved position to resume from. */
  position?: PlaybackPosition;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  onBack: () => void;
  onEdit: () => void;
  /** Called as playback moves, so the library can remember where we are. */
  onPosition?: (position: PlaybackPosition) => void;
}

/** Don't write to IndexedDB on every word. */
const POSITION_SAVE_MS = 3000;

export function ReaderScreen(props: Props) {
  const doc = useMemo(() => tokenize(props.text), [props.text]);
  const engines = useMemo(() => availableEngines(), []);

  // Resume: prefer the exact token, but re-anchor by character offset if the
  // text was edited since the position was saved.
  const startToken = useMemo(() => {
    if (!props.position) return 0;
    const { tokenIndex, charIndex } = props.position;
    const guess = doc.tokens[tokenIndex];
    if (guess && Math.abs(guess.start - charIndex) < 40) return tokenIndex;
    const found = doc.tokens.findIndex((t) => t.end > charIndex);
    return found === -1 ? 0 : found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const player = usePlayer(doc, {
    engineId: props.prefs.engineId,
    voiceId: props.prefs.voiceId,
    rate: props.prefs.rate,
    startToken,
  });

  const { state, seek } = player;

  // Persist the position, throttled.
  const lastSave = useRef(0);
  useEffect(() => {
    if (!props.onPosition) return;
    const now = Date.now();
    if (now - lastSave.current < POSITION_SAVE_MS) return;
    lastSave.current = now;
    props.onPosition({
      tokenIndex: state.tokenIndex,
      charIndex: doc.tokens[state.tokenIndex]?.start ?? 0,
      updatedAt: now,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tokenIndex]);

  // ...and once more on the way out, so leaving mid-sentence resumes exactly.
  useEffect(() => {
    return () => {
      props.onPosition?.({
        tokenIndex: player.state.tokenIndex,
        charIndex: doc.tokens[player.state.tokenIndex]?.start ?? 0,
        updatedAt: Date.now(),
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the last-used voice/speed as the default for the next document.
  useEffect(() => {
    props.onPrefs({ rate: state.rate, voiceId: state.voiceId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rate, state.voiceId]);

  const totalChars = doc.text.length;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/95 backdrop-blur safe-top">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2">
          <IconButton label="Back to library" onClick={props.onBack}>
            <BackIcon />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {props.title}
          </h1>
          <IconButton label="Edit text" onClick={props.onEdit}>
            <PencilIcon />
          </IconButton>
        </div>
      </header>

      {state.error && (
        <p className="mx-auto max-w-3xl px-4 pt-3 text-sm text-danger">{state.error}</p>
      )}

      <main className="mx-auto max-w-3xl px-4 pt-6 pb-56">
        <Reader
          doc={doc}
          activeToken={state.tokenIndex}
          activeSentence={state.sentenceIndex}
          onSeek={(i) => seek(i, state.status === 'playing')}
          fontSize={props.prefs.fontSize}
          playing={state.status === 'playing'}
        />
      </main>

      <PlayerControls
        state={state}
        engine={player.engine}
        engines={engines}
        voices={player.voices}
        totalTokens={doc.tokens.length}
        totalChars={totalChars}
        onToggle={player.toggle}
        onNext={player.next}
        onPrevious={player.previous}
        onSeekFraction={(f) =>
          seek(Math.round(f * (doc.tokens.length - 1)), state.status === 'playing')
        }
        onRate={player.setRate}
        onVoice={player.setVoice}
        onEngine={(id) => {
          player.setEngineId(id);
          props.onPrefs({ engineId: id });
        }}
        fontSize={props.prefs.fontSize}
        onFontSize={(px) => props.onPrefs({ fontSize: px })}
        theme={props.prefs.theme}
        onTheme={(theme) => props.onPrefs({ theme })}
      />
    </div>
  );
}
