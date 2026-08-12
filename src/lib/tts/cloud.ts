/**
 * ============================================================================
 *  STUB — Cloud TTS provider (ElevenLabs / OpenAI / Google / Azure)
 * ============================================================================
 *
 * Nothing here is wired up. It is a filled-in skeleton showing exactly what a
 * natural-voice provider has to implement, so swapping the robotic built-in
 * voice for a good one is an afternoon rather than a rewrite. The player, the
 * highlighter and the controls all talk to `TtsEngine` and need no changes.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE API KEY GOES
 * ---------------------------------------------------------------------------
 * Not in this file, and not in the browser at all if the app is ever hosted
 * somewhere other than your own machine: anything the browser can read, a
 * visitor can read. Two options:
 *
 *   (a) Personal / local use — put it in `.env.local` (git-ignored) as
 *           VITE_TTS_API_KEY=sk-...
 *       and read it below via `import.meta.env.VITE_TTS_API_KEY`. Vite inlines
 *       any VITE_-prefixed variable into the bundle, so treat that build as
 *       secret. This is the only client-only option.
 *
 *   (b) Shared / deployed — the key lives on a small proxy you own
 *       (`POST /api/tts` -> provider), and this file calls that instead. That
 *       is a backend, which the app deliberately does not have today.
 *
 * ---------------------------------------------------------------------------
 * WORD TIMINGS — the part that matters for highlighting
 * ---------------------------------------------------------------------------
 * Highlighting needs to know when each word is spoken. Providers differ:
 *
 *   ElevenLabs  `/v1/text-to-speech/{voice}/with-timestamps` returns
 *               `alignment.character_start_times_seconds[]`, one entry per
 *               character. Fold those into per-word times and you get
 *               highlighting as tight as the built-in engine, arguably tighter.
 *   Azure       Sends `WordBoundary` events over its SDK/websocket.
 *   Google      `timepoint` marks, if you send SSML with <mark> per word.
 *   OpenAI      No timings at all today. You would fall back to the same
 *               estimator the player already uses for boundary-less voices.
 *
 * ---------------------------------------------------------------------------
 * SPEED ABOVE 3×
 * ---------------------------------------------------------------------------
 * This is the reason to want a cloud voice beyond quality. Cloud providers
 * return an audio file, and `HTMLAudioElement.playbackRate` genuinely honours
 * 5× — so this engine advertises `maxRate = 5` and the speed slider extends
 * itself automatically. Ask the provider for ~1× audio and do the whole speed
 * change with `playbackRate`; the browser's time-stretching sounds better than
 * most providers' own speed parameter, and word timings then just divide by
 * the rate. Set `preservesPitch = true` or fast playback sounds like a chipmunk.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 * Billed per character. A 300-page book is roughly 600k characters — worth
 * caching every synthesised sentence in IndexedDB next to the document, and
 * worth showing the user an estimate before a long document starts.
 */

import type { SpeakHandlers, TtsEngine, TtsVoice } from './types';

/** Option (a) above. Undefined unless you create `.env.local`. */
const API_KEY = import.meta.env.VITE_TTS_API_KEY as string | undefined;

export class CloudTtsEngine implements TtsEngine {
  readonly id = 'cloud';
  readonly label = 'Natural voice (cloud)';
  readonly description =
    'Human-sounding narration from a cloud provider. Needs an API key and bills per character.';
  /** Real 5×: the audio element does the speed-up, not the synthesiser. */
  readonly maxRate = 5;
  readonly minRate = 0.5;
  readonly emitsWordBoundaries = true;

  #audio: HTMLAudioElement | null = null;
  #voiceId: string | null = null;
  #rate = 1;

  /** Hidden from the UI until a key exists — no dead option in the picker. */
  isAvailable(): boolean {
    return Boolean(API_KEY);
  }

  async getVoices(): Promise<TtsVoice[]> {
    // TODO: GET the provider's voice list, e.g. ElevenLabs /v1/voices.
    return [];
  }

  setVoice(id: string | null): void {
    this.#voiceId = id;
  }

  getVoice(): string | null {
    return this.#voiceId;
  }

  setRate(rate: number): void {
    this.#rate = rate;
    if (this.#audio) this.#audio.playbackRate = rate;
  }

  /** Applied to the <audio> element, which is what makes a real 5x possible. */
  get rate(): number {
    return this.#rate;
  }

  speak(_text: string, handlers: SpeakHandlers): void {
    handlers.onError?.(
      new Error(
        'The cloud voice is a stub. See src/lib/tts/cloud.ts for what to fill in.',
      ),
    );

    /* Sketch of the real thing:
     *
     *   const res = await fetch(ENDPOINT, {
     *     method: 'POST',
     *     headers: { 'xi-api-key': API_KEY!, 'content-type': 'application/json' },
     *     body: JSON.stringify({ text, voice_id: this.#voiceId, model_id: '...' }),
     *   });
     *   const { audio_base64, alignment } = await res.json();
     *
     *   // characters -> words, so the player gets the same events the Web
     *   // Speech engine produces.
     *   const marks = wordStartTimes(text, alignment);
     *
     *   const audio = new Audio(`data:audio/mpeg;base64,${audio_base64}`);
     *   audio.preservesPitch = true;
     *   audio.playbackRate = this.#rate;
     *   let next = 0;
     *   audio.ontimeupdate = () => {
     *     while (next < marks.length && audio.currentTime >= marks[next].time) {
     *       handlers.onWordBoundary?.({
     *         charIndex: marks[next].charIndex,
     *         charLength: marks[next].length,
     *       });
     *       next++;
     *     }
     *   };
     *   audio.onended = () => handlers.onEnd?.();
     *   this.#audio = audio;
     *   await audio.play();
     *
     * `ontimeupdate` fires about every 250ms, which is too coarse for tight
     * word highlighting — drive the same loop from requestAnimationFrame
     * instead, reading `audio.currentTime`.
     *
     * Prefetch the *next* sentence while the current one plays, or every
     * sentence boundary becomes a network round-trip.
     */
  }

  pause(): void {
    this.#audio?.pause();
  }

  resume(): void {
    void this.#audio?.play();
  }

  stop(): void {
    if (!this.#audio) return;
    this.#audio.pause();
    this.#audio.src = '';
    this.#audio = null;
  }

  isSpeaking(): boolean {
    return Boolean(this.#audio && !this.#audio.paused);
  }

  isPaused(): boolean {
    return Boolean(this.#audio?.paused);
  }
}
