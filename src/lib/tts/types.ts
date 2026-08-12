/**
 * The TTS boundary.
 * =================
 *
 * Everything above this interface (the player, the highlighter, the controls)
 * knows only about `TtsEngine`. Swapping the browser's built-in voice for a
 * cloud voice means adding one file that implements this — no changes to
 * playback, highlighting or the UI.
 *
 * The contract in one paragraph: `speak()` starts a chunk of text and fires
 * `onWordBoundary` with the character offset *within that chunk* as each word
 * begins, then `onEnd` exactly once. `pause`/`resume`/`stop` do what they say.
 * `setRate` applies from the next chunk at the latest, immediately if the
 * engine can.
 */

export interface TtsVoice {
  id: string;
  name: string;
  /** BCP-47 tag, e.g. "en-GB". */
  lang: string;
  /** Voice runs on-device (no network, no per-character cost). */
  local: boolean;
  /** The engine's own default. */
  isDefault?: boolean;
}

export interface BoundaryEvent {
  /** Offset of the word being spoken, relative to the text passed to speak(). */
  charIndex: number;
  /** Length of that word, when the engine reports it (0 if unknown). */
  charLength: number;
}

export interface SpeakHandlers {
  onWordBoundary?: (e: BoundaryEvent) => void;
  /** Fires once when the chunk finishes normally (not when stopped). */
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

export interface TtsEngine {
  readonly id: string;
  readonly label: string;
  /** One line for the settings sheet: what this engine costs / sounds like. */
  readonly description: string;

  /**
   * The fastest rate this engine *actually* honours. The speed slider is built
   * from this, so it can never promise a speed the engine will silently ignore.
   */
  readonly maxRate: number;
  readonly minRate: number;

  /**
   * False when the engine cannot report word boundaries, so the player must
   * estimate word timings instead. May flip to false at runtime after the
   * first chunk (some browsers only reveal this by staying silent).
   */
  readonly emitsWordBoundaries: boolean;

  /** Usable in this browser right now. */
  isAvailable(): boolean;

  /** Ready-to-use voices. May be empty until the platform has loaded them. */
  getVoices(): Promise<TtsVoice[]>;
  setVoice(voiceId: string | null): void;
  getVoice(): string | null;

  setRate(rate: number): void;

  /** Speak one chunk. Any chunk already playing is replaced. */
  speak(text: string, handlers: SpeakHandlers): void;
  pause(): void;
  resume(): void;
  /** Stop and discard the queue. `onEnd` must NOT fire for a stopped chunk. */
  stop(): void;

  /** True while audio is actually being produced. Used to detect stalls. */
  isSpeaking(): boolean;
  isPaused(): boolean;
}
