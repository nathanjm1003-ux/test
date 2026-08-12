/** The transport bar: scrubber, play/pause, sentence skip, speed and voice. */

import { useEffect, useState } from 'react';
import {
  IconButton,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  SlidersIcon,
} from './ui';
import { Sheet } from './Sheet';
import type { PlayerState } from '../lib/player';
import type { TtsEngine, TtsVoice } from '../lib/tts/types';

interface Props {
  state: PlayerState;
  engine: TtsEngine;
  engines: TtsEngine[];
  voices: TtsVoice[];
  totalTokens: number;
  totalChars: number;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeekFraction: (fraction: number) => void;
  onRate: (rate: number) => void;
  onVoice: (id: string) => void;
  onEngine: (id: string) => void;
  fontSize: number;
  onFontSize: (px: number) => void;
  theme: 'dark' | 'light';
  onTheme: (t: 'dark' | 'light') => void;
}

const PRESETS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];

/** Rough time left, from characters remaining at ~15 chars/sec per 1× rate. */
function timeLeft(charsLeft: number, rate: number): string {
  const seconds = charsLeft / (15 * rate);
  if (seconds < 60) return 'under a minute left';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}

export function PlayerControls(props: Props) {
  const { state, engine, voices } = props;
  const [sheet, setSheet] = useState(false);
  const playing = state.status === 'playing';

  const progress = props.totalTokens
    ? state.tokenIndex / Math.max(1, props.totalTokens - 1)
    : 0;

  // Space bar toggles playback, arrows skip sentences — desktop nicety.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, select')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        props.onToggle();
      } else if (e.code === 'ArrowRight') {
        props.onNext();
      } else if (e.code === 'ArrowLeft') {
        props.onPrevious();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const localVoices = voices.filter((v) => v.local);
  const remoteVoices = voices.filter((v) => !v.local);

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/95 backdrop-blur safe-bottom">
        <div className="mx-auto max-w-3xl px-4 pt-2">
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onChange={(e) => props.onSeekFraction(Number(e.target.value) / 1000)}
            aria-label="Position in document"
            className="w-full"
          />

          <div className="flex items-center justify-between gap-2 pb-2">
            <button
              onClick={() => setSheet(true)}
              className="min-w-[3.5rem] rounded-lg px-2 py-1.5 text-left text-sm font-semibold text-accent tabular-nums"
              aria-label="Playback speed and voice"
            >
              {state.rate}×
            </button>

            <div className="flex items-center gap-1">
              <IconButton label="Previous sentence" onClick={props.onPrevious}>
                <PrevIcon />
              </IconButton>
              <IconButton
                label={playing ? 'Pause' : 'Play'}
                variant="primary"
                size="lg"
                onClick={props.onToggle}
              >
                {playing ? (
                  <PauseIcon className="h-7 w-7" />
                ) : (
                  <PlayIcon className="h-7 w-7" />
                )}
              </IconButton>
              <IconButton label="Next sentence" onClick={props.onNext}>
                <NextIcon />
              </IconButton>
            </div>

            <IconButton label="Settings" onClick={() => setSheet(true)}>
              <SlidersIcon />
            </IconButton>
          </div>

          <p className="pb-1 text-center text-[11px] text-ink-faint">
            {state.status === 'ended'
              ? 'Finished'
              : timeLeft(props.totalChars * (1 - progress), state.rate)}
            {state.estimating && ' · highlighting estimated for this voice'}
          </p>
        </div>
      </div>

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Playback">
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <label htmlFor="rate" className="text-sm font-medium">
              Speed
            </label>
            <span className="text-sm tabular-nums text-ink-soft">{state.rate}×</span>
          </div>
          <input
            id="rate"
            type="range"
            min={engine.minRate}
            max={engine.maxRate}
            step={0.25}
            value={state.rate}
            onChange={(e) => props.onRate(Number(e.target.value))}
            className="w-full"
          />
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.filter((r) => r <= engine.maxRate).map((r) => (
              <button
                key={r}
                onClick={() => props.onRate(r)}
                className={`rounded-lg px-2.5 py-1 text-xs tabular-nums transition ${
                  state.rate === r
                    ? 'bg-accent text-accent-ink'
                    : 'bg-surface-2 text-ink-soft hover:text-ink'
                }`}
              >
                {r}×
              </button>
            ))}
          </div>
          {engine.maxRate < 5 && (
            <p className="text-xs text-ink-faint">
              {engine.label} genuinely tops out at {engine.maxRate}× — the Web Speech
              API ignores anything faster, so the slider stops where the sound
              actually changes. A cloud voice returns an audio file and can be
              pushed to 5× (see <code>src/lib/tts/cloud.ts</code>).
            </p>
          )}
        </section>

        <section className="mt-6 space-y-2">
          <label htmlFor="voice" className="text-sm font-medium">
            Voice
          </label>
          {voices.length === 0 ? (
            <p className="text-xs text-ink-faint">
              No voices reported by this browser yet. On Linux, install a speech
              engine such as <code>espeak-ng</code>; on Chrome, the list fills in a
              moment after the page loads.
            </p>
          ) : (
            <select
              id="voice"
              value={state.voiceId ?? ''}
              onChange={(e) => props.onVoice(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm"
            >
              {localVoices.length > 0 && (
                <optgroup label="On this device">
                  {localVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </optgroup>
              )}
              {remoteVoices.length > 0 && (
                <optgroup label="Network voices (no word timings)">
                  {remoteVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
        </section>

        {props.engines.length > 1 && (
          <section className="mt-6 space-y-2">
            <label htmlFor="engine" className="text-sm font-medium">
              Engine
            </label>
            <select
              id="engine"
              value={engine.id}
              onChange={(e) => props.onEngine(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm"
            >
              {props.engines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-faint">{engine.description}</p>
          </section>
        )}

        <section className="mt-6 space-y-3">
          <div className="flex items-baseline justify-between">
            <label htmlFor="font" className="text-sm font-medium">
              Text size
            </label>
            <span className="text-sm tabular-nums text-ink-soft">{props.fontSize}px</span>
          </div>
          <input
            id="font"
            type="range"
            min={15}
            max={28}
            step={1}
            value={props.fontSize}
            onChange={(e) => props.onFontSize(Number(e.target.value))}
            className="w-full"
          />
        </section>

        <section className="mt-6 flex items-center justify-between">
          <span className="text-sm font-medium">Theme</span>
          <div className="flex rounded-xl bg-surface-2 p-1">
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                onClick={() => props.onTheme(t)}
                className={`rounded-lg px-3 py-1.5 text-xs capitalize transition ${
                  props.theme === t ? 'bg-accent text-accent-ink' : 'text-ink-soft'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </section>
      </Sheet>
    </>
  );
}
