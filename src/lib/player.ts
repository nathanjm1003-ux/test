/**
 * Playback engine.
 * ================
 *
 * Sits between the UI and a `TtsEngine`. Owns:
 *   - which word is currently being spoken (the thing the reader highlights)
 *   - sentence-by-sentence chunking and auto-advance
 *   - seeking (tap a word, skip a sentence)
 *   - the fallback word-timing estimator for voices that don't report
 *     boundaries (Chrome's network voices, most iOS voices)
 *
 * It is deliberately framework-free — `usePlayer` is a thin React wrapper — so
 * the tricky timing logic can be reasoned about (and tested) on its own.
 */

import { tokenAtChar, type Tokenized } from './text/tokenize';
import type { TtsEngine } from './tts/types';

export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'ended';

export interface PlayerState {
  status: PlayerStatus;
  /** Index of the word being spoken. */
  tokenIndex: number;
  sentenceIndex: number;
  rate: number;
  voiceId: string | null;
  /** True when word positions are estimated because the voice is silent about them. */
  estimating: boolean;
  error: string | null;
}

/**
 * Speaking speed in characters per second at rate 1.0, used only by the
 * estimator. ~15 c/s is about 175 wpm, which is where the common system voices
 * land. Drift inside one sentence stays under a word or so, and every sentence
 * boundary resynchronises against the engine's real `onEnd`.
 */
const CHARS_PER_SECOND = 15;

/** Estimator tick. Fine enough to look continuous, coarse enough to be free. */
const TICK_MS = 60;

/**
 * If the engine has produced no boundary event this long after a chunk starts,
 * take over with estimated timings. Slightly longer than the engine's own
 * probe so its `emitsWordBoundaries` flag has settled first.
 */
const FALLBACK_AFTER_MS = 900;

export class Player {
  #engine: TtsEngine;
  #doc: Tokenized = { text: '', tokens: [], sentences: [] };
  #listeners = new Set<(s: PlayerState) => void>();

  #state: PlayerState = {
    status: 'idle',
    tokenIndex: 0,
    sentenceIndex: 0,
    rate: 1,
    voiceId: null,
    estimating: false,
    error: null,
  };

  // --- estimator bookkeeping ---
  #timer: number | null = null;
  #watchdog: number | null = null;
  #boundarySeen = false;
  /**
   * Sticky for the session once decided: this voice does not report word
   * positions, so every chunk from here on is highlighted from a clock.
   */
  #useEstimator = false;
  /** Wall-clock start of the current chunk and the token it started on. */
  #chunkStartedAt = 0;
  #chunkStartToken = 0;

  constructor(engine: TtsEngine) {
    this.#engine = engine;
    this.#state.rate = Math.min(engine.maxRate, this.#state.rate);
    this.#useEstimator = !engine.emitsWordBoundaries;
    this.#state.estimating = this.#useEstimator;
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  subscribe(fn: (s: PlayerState) => void): () => void {
    this.#listeners.add(fn);
    fn(this.#state);
    return () => this.#listeners.delete(fn);
  }

  get state(): PlayerState {
    return this.#state;
  }

  get engine(): TtsEngine {
    return this.#engine;
  }

  get doc(): Tokenized {
    return this.#doc;
  }

  #emit(patch: Partial<PlayerState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn(this.#state);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  setDocument(doc: Tokenized, startToken = 0): void {
    this.stop();
    this.#doc = doc;
    this.#emit({
      status: 'idle',
      tokenIndex: Math.min(startToken, Math.max(0, doc.tokens.length - 1)),
      sentenceIndex: doc.tokens[startToken]?.sentence ?? 0,
      error: null,
    });
  }

  /** Swap the speech engine (built-in <-> cloud) without losing position. */
  setEngine(engine: TtsEngine): void {
    const wasPlaying = this.#state.status === 'playing';
    this.stop();
    this.#engine = engine;
    this.#useEstimator = !engine.emitsWordBoundaries;
    this.#emit({ estimating: this.#useEstimator });
    const rate = Math.min(engine.maxRate, Math.max(engine.minRate, this.#state.rate));
    engine.setRate(rate);
    this.#emit({ rate, voiceId: engine.getVoice() });
    if (wasPlaying) this.play();
  }

  setVoice(voiceId: string | null): void {
    this.#engine.setVoice(voiceId);
    this.#emit({ voiceId });
    // Heard immediately rather than at the next sentence.
    if (this.#state.status === 'playing') this.#restartFromCurrent();
  }

  setRate(rate: number): void {
    const clamped = Math.min(this.#engine.maxRate, Math.max(this.#engine.minRate, rate));
    this.#engine.setRate(clamped);
    this.#emit({ rate: clamped });
    if (this.#state.status === 'playing') this.#restartFromCurrent();
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  play(fromToken?: number): void {
    if (!this.#doc.tokens.length) return;

    // Resume from a native pause is cheap; anything else re-speaks the chunk.
    if (fromToken === undefined && this.#state.status === 'paused' && this.#engine.isPaused()) {
      this.#engine.resume();
      this.#emit({ status: 'playing' });
      this.#chunkStartedAt = performance.now();
      this.#chunkStartToken = this.#state.tokenIndex;
      if (this.#useEstimator) this.#startEstimator();
      // Some Android builds treat pause() as stop(); if nothing is coming out
      // of the speaker shortly after resume, re-speak from where we were.
      window.setTimeout(() => {
        if (this.#state.status === 'playing' && !this.#engine.isSpeaking()) {
          this.#speakFrom(this.#state.tokenIndex);
        }
      }, 250);
      return;
    }

    this.#speakFrom(fromToken ?? this.#state.tokenIndex);
  }

  pause(): void {
    if (this.#state.status !== 'playing') return;
    this.#stopTimers();
    this.#engine.pause();
    this.#emit({ status: 'paused' });
  }

  toggle(): void {
    if (this.#state.status === 'playing') this.pause();
    else this.play();
  }

  stop(): void {
    this.#stopTimers();
    this.#engine.stop();
    if (this.#state.status !== 'idle') this.#emit({ status: 'idle' });
  }

  /** Jump to a word — used by tap-to-seek and by resume-from-library. */
  seekToToken(tokenIndex: number, autoplay = this.#state.status === 'playing'): void {
    const index = Math.max(0, Math.min(tokenIndex, this.#doc.tokens.length - 1));
    if (autoplay) {
      this.#speakFrom(index);
    } else {
      this.#stopTimers();
      this.#engine.stop();
      this.#emit({
        tokenIndex: index,
        sentenceIndex: this.#doc.tokens[index]?.sentence ?? 0,
        status: this.#state.status === 'playing' ? 'paused' : this.#state.status,
      });
    }
  }

  /**
   * Skip back: to the start of the current sentence, or to the previous
   * sentence if we are already at the start of this one — the behaviour every
   * audio player has trained people to expect.
   */
  previousSentence(): void {
    const { sentences } = this.#doc;
    const current = this.#state.sentenceIndex;
    const atStart = this.#state.tokenIndex <= sentences[current]?.firstToken;
    const target = atStart ? Math.max(0, current - 1) : current;
    this.seekToToken(sentences[target]?.firstToken ?? 0);
  }

  nextSentence(): void {
    const { sentences } = this.#doc;
    const target = this.#state.sentenceIndex + 1;
    if (target >= sentences.length) {
      this.stop();
      this.#emit({ status: 'ended', tokenIndex: this.#doc.tokens.length - 1 });
      return;
    }
    this.seekToToken(sentences[target].firstToken);
  }

  destroy(): void {
    this.#stopTimers();
    this.#engine.stop();
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #restartFromCurrent(): void {
    this.#speakFrom(this.#state.tokenIndex);
  }

  /**
   * Speak from `tokenIndex` to the end of its sentence, then continue.
   *
   * Note this is called synchronously from the play button's click handler on
   * the first play, which iOS requires — do not make this path async.
   */
  #speakFrom(tokenIndex: number): void {
    const { tokens, sentences, text } = this.#doc;
    if (!tokens.length) return;

    if (tokenIndex >= tokens.length) {
      this.#stopTimers();
      this.#emit({ status: 'ended' });
      return;
    }

    const token = tokens[tokenIndex];
    const sentence = sentences[token.sentence];
    const offset = token.start;
    const chunk = text.slice(offset, sentence.end);

    this.#stopTimers();
    this.#boundarySeen = false;
    this.#chunkStartedAt = performance.now();
    this.#chunkStartToken = tokenIndex;

    this.#emit({
      status: 'playing',
      tokenIndex,
      sentenceIndex: token.sentence,
      error: null,
    });

    this.#engine.speak(chunk, {
      onWordBoundary: ({ charIndex }) => {
        // Not all engines stop calling back the instant they are paused
        // (Android Chrome in particular), so ignore anything that arrives
        // while we are not meant to be playing.
        if (this.#state.status !== 'playing') return;

        this.#boundarySeen = true;
        if (this.#useEstimator) {
          this.#useEstimator = false;
          this.#stopEstimator();
          this.#emit({ estimating: false });
        }
        const index = tokenAtChar(tokens, offset + charIndex);
        // Never move backwards inside a chunk: some engines report the same or an
        // earlier offset for hyphenated or quoted words.
        if (index >= this.#state.tokenIndex && index <= sentence.lastToken) {
          this.#emit({ tokenIndex: index, sentenceIndex: tokens[index].sentence });
        }
      },
      onEnd: () => {
        if (this.#state.status !== 'playing') return;
        this.#stopTimers();

        // A whole chunk with no boundary event settles the question for the
        // rest of the session: this voice does not report word positions.
        // Without this, short sentences would each finish before the watchdog
        // fired and the highlight would only ever move once per sentence.
        if (!this.#boundarySeen && !this.#useEstimator) {
          this.#useEstimator = true;
          this.#emit({ estimating: true });
        }

        const next = sentence.lastToken + 1;
        if (next < tokens.length) {
          this.#speakFrom(next);
        } else {
          this.#emit({ status: 'ended', tokenIndex: tokens.length - 1 });
        }
      },
      onError: (error) => {
        this.#stopTimers();
        this.#emit({ status: 'paused', error: error.message });
      },
    });

    if (this.#useEstimator) {
      // Already know this voice is silent — start estimating straight away.
      this.#startEstimator();
    } else {
      // First encounter: give the engine a moment to prove it reports
      // boundaries, then take over if it doesn't.
      this.#watchdog = window.setTimeout(() => {
        if (this.#boundarySeen || this.#state.status !== 'playing') return;
        this.#useEstimator = true;
        this.#emit({ estimating: true });
        this.#startEstimator();
      }, FALLBACK_AFTER_MS);
    }
  }

  /**
   * Estimated highlighting.
   *
   * Each word is assumed to take (characters + 1) / (15 * rate) seconds. The
   * loop re-reads the elapsed wall-clock time every tick rather than
   * accumulating, so a throttled background tab catches up instead of drifting.
   */
  #startEstimator(): void {
    this.#stopEstimator();
    if (!this.#state.estimating) this.#emit({ estimating: true });
    const { tokens, sentences } = this.#doc;
    const startToken = this.#chunkStartToken;
    const sentence = sentences[tokens[startToken]?.sentence ?? 0];
    if (!sentence) return;

    // Cumulative milliseconds from the chunk start to the start of each word.
    const offsets: number[] = [];
    let acc = 0;
    for (let i = startToken; i <= sentence.lastToken; i++) {
      offsets.push(acc);
      acc += ((tokens[i].text.length + 1) / (CHARS_PER_SECOND * this.#state.rate)) * 1000;
    }

    this.#timer = window.setInterval(() => {
      if (this.#state.status !== 'playing') return;
      const elapsed = performance.now() - this.#chunkStartedAt;
      let index = startToken;
      while (
        index - startToken + 1 < offsets.length &&
        elapsed >= offsets[index - startToken + 1]
      ) {
        index++;
      }
      if (index !== this.#state.tokenIndex) {
        this.#emit({ tokenIndex: index, sentenceIndex: tokens[index].sentence });
      }
    }, TICK_MS);
  }

  #stopEstimator(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #stopTimers(): void {
    this.#stopEstimator();
    if (this.#watchdog !== null) clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }
}
