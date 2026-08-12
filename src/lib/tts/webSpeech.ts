/**
 * Web Speech API engine (the default).
 * ====================================
 *
 * Free, offline, no key, and — crucially — it emits `boundary` events, which
 * is what makes word-level highlighting exact rather than estimated. The
 * trade-off is voice quality: on most desktops these are the old system
 * voices. See ./cloud.ts for dropping in a natural-sounding provider.
 *
 * This file exists mostly to paper over five well-known platform quirks:
 *
 *  1. `getVoices()` is empty until the platform fires `voiceschanged`.
 *  2. Chrome silently truncates any utterance running longer than ~15s
 *     unless something calls `resume()` periodically.
 *  3. `cancel()` immediately followed by `speak()` can drop the new utterance
 *     in Chrome, so a replacement is deferred by a frame or two.
 *  4. `cancel()` fires `onerror` with 'interrupted'/'canceled'. That is our
 *     own doing and must not surface as an error, and must not fire `onEnd`.
 *  5. Chrome's *network* voices (the "Google …" ones) and several iOS voices
 *     never emit `boundary`. We detect that and let the player fall back to
 *     estimated word timings.
 */

import type {
  SpeakHandlers,
  TtsEngine,
  TtsVoice,
} from './types';

/**
 * Rates above this are clamped or ignored by every shipping implementation, so
 * the speed slider stops here rather than pretending. A cloud engine that
 * returns an audio file can go faster via `HTMLAudioElement.playbackRate`.
 */
const REAL_MAX_RATE = 3;

/** How often to poke `resume()` to defeat the Chrome truncation bug. */
const KEEPALIVE_MS = 8000;

/** If no boundary event has arrived this long after a chunk starts, assume
 *  this voice does not emit them. Generous, because the first utterance on a
 *  cold engine can take a moment to actually begin. */
const BOUNDARY_PROBE_MS = 1200;

const voiceId = (v: SpeechSynthesisVoice) => `${v.name}::${v.lang}`;

export class WebSpeechEngine implements TtsEngine {
  readonly id = 'web-speech';
  readonly label = 'Built-in voice';
  readonly description =
    'Your device’s own voices. Free, private, works offline. Robotic on some platforms.';
  readonly maxRate = REAL_MAX_RATE;
  readonly minRate = 0.5;

  #emitsBoundaries = true;
  #voiceId: string | null = null;
  #rate = 1;
  /**
   * Kept alive deliberately: if the utterance object is garbage collected
   * mid-speech, Chrome and Safari never fire `onend` and playback stalls at the
   * end of the sentence. Holding the reference here prevents that.
   */
  #utterance: SpeechSynthesisUtterance | null = null;
  #keepAlive: number | null = null;
  #probe: number | null = null;
  /** Incremented on every stop/replace so stale callbacks can be ignored. */
  #generation = 0;
  #paused = false;
  #startTimer: number | null = null;

  get emitsWordBoundaries(): boolean {
    return this.#emitsBoundaries;
  }

  isAvailable(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  async getVoices(): Promise<TtsVoice[]> {
    if (!this.isAvailable()) return [];

    const read = () => speechSynthesis.getVoices();
    let list = read();

    if (!list.length) {
      // Quirk 1: voices arrive asynchronously on first load.
      list = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          speechSynthesis.removeEventListener('voiceschanged', done);
          resolve(read());
        };
        const timeout = setTimeout(done, 2000);
        speechSynthesis.addEventListener('voiceschanged', done);
      });
    }

    return list.map((v) => ({
      id: voiceId(v),
      name: v.name,
      lang: v.lang,
      local: v.localService,
      isDefault: v.default,
    }));
  }

  setVoice(id: string | null): void {
    this.#voiceId = id;
  }

  getVoice(): string | null {
    return this.#voiceId;
  }

  setRate(rate: number): void {
    this.#rate = Math.min(this.maxRate, Math.max(this.minRate, rate));
    // The spec has no way to retune a live utterance; the player restarts the
    // current sentence so the change is heard immediately.
  }

  #resolveVoice(): SpeechSynthesisVoice | null {
    if (!this.#voiceId) return null;
    return speechSynthesis.getVoices().find((v) => voiceId(v) === this.#voiceId) ?? null;
  }

  speak(text: string, handlers: SpeakHandlers): void {
    if (!this.isAvailable()) {
      handlers.onError?.(new Error('Speech synthesis is not available in this browser.'));
      return;
    }

    const generation = ++this.#generation;
    this.#clearTimers();
    this.#paused = false;

    const start = () => {
      if (generation !== this.#generation) return; // superseded while waiting

      const utterance = new SpeechSynthesisUtterance(text);
      const voice = this.#resolveVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = this.#rate;
      utterance.pitch = 1;
      utterance.volume = 1;

      let sawBoundary = false;

      utterance.onboundary = (e) => {
        if (generation !== this.#generation) return;
        // Chrome also emits 'sentence' boundaries; we only want words.
        if (e.name && e.name !== 'word') return;
        sawBoundary = true;
        this.#emitsBoundaries = true;
        handlers.onWordBoundary?.({
          charIndex: e.charIndex ?? 0,
          charLength: e.charLength ?? 0,
        });
      };

      utterance.onend = () => {
        if (generation !== this.#generation) return;
        this.#clearTimers();
        this.#utterance = null;
        handlers.onEnd?.();
      };

      utterance.onerror = (e) => {
        if (generation !== this.#generation) return;
        this.#clearTimers();
        this.#utterance = null;
        // Quirk 4: our own cancel() lands here. Not an error.
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        handlers.onError?.(new Error(`Speech failed: ${e.error}`));
      };

      this.#utterance = utterance;
      speechSynthesis.speak(utterance);

      // Quirk 5: decide whether this voice reports word boundaries at all.
      this.#probe = window.setTimeout(() => {
        if (generation !== this.#generation) return;
        if (!sawBoundary && speechSynthesis.speaking) this.#emitsBoundaries = false;
      }, BOUNDARY_PROBE_MS);

      // Quirk 2: keep long utterances alive.
      this.#keepAlive = window.setInterval(() => {
        if (generation !== this.#generation) return;
        if (this.#paused) return;
        if (speechSynthesis.speaking) speechSynthesis.resume();
      }, KEEPALIVE_MS);
    };

    // Quirk 3: give Chrome a beat between cancel() and the next speak().
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      this.#startTimer = window.setTimeout(start, 60);
    } else {
      start();
    }
  }

  pause(): void {
    if (!this.isAvailable()) return;
    this.#paused = true;
    speechSynthesis.pause();
  }

  resume(): void {
    if (!this.isAvailable()) return;
    this.#paused = false;
    speechSynthesis.resume();
  }

  stop(): void {
    if (!this.isAvailable()) return;
    this.#generation++;
    this.#clearTimers();
    this.#paused = false;
    this.#utterance = null;
    speechSynthesis.cancel();
  }

  isSpeaking(): boolean {
    return (
      this.isAvailable() &&
      this.#utterance !== null &&
      speechSynthesis.speaking &&
      !speechSynthesis.paused
    );
  }

  isPaused(): boolean {
    // Android Chrome does not always reflect pause() in `speechSynthesis.paused`,
    // so trust our own flag first.
    return this.#paused || (this.isAvailable() && speechSynthesis.paused);
  }

  #clearTimers(): void {
    if (this.#keepAlive !== null) clearInterval(this.#keepAlive);
    if (this.#probe !== null) clearTimeout(this.#probe);
    if (this.#startTimer !== null) clearTimeout(this.#startTimer);
    this.#keepAlive = this.#probe = this.#startTimer = null;
  }
}
