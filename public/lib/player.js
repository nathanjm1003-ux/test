// Variable-speed audio player with two interchangeable engines.
//
//   native — an <audio> element with `playbackRate` + `preservesPitch`. Streams
//            straight off disk at any file size, costs nothing, sounds good. But
//            browsers only reliably honour a modest range and quietly clamp or
//            mute past it, so we probe the real ceiling and never push it.
//
//   wsola  — our own WSOLA time-stretcher in an AudioWorklet. Reaches 10x on any
//            browser with AudioWorklet, and makes pitch an independent control
//            instead of a side effect of speed.
//
// `auto` picks native while it is safely in range and switches to wsola when the
// requested speed exceeds it, or when pitch is shifted at all. Switching hands
// the playback position across so it is inaudible.
//
// LARGE FILES: the worklet is fed a sliding window (see WINDOW_SECONDS), never
// the whole track, so memory is bounded by the window rather than the file. For
// uncompressed audio that makes size irrelevant — a 1GB WAV time-stretches in a
// few tens of MB. Compressed formats have to be decoded whole before they can be
// windowed at all, so they are capped by a memory budget instead; past it the
// native engine still streams the file, and `stretchBlockedReason` explains why
// the speed ceiling dropped.

import { createAudioSource, inspectSource, TooLargeToDecodeError, DEFAULT_BUDGET_BYTES } from './sources/index.js';
import { formatBytes } from './format.js';
import { createFallbackNode } from './fallback-node.js';

const MODULE_PARTS = [
  new URL('./wsola-core.js', import.meta.url),
  new URL('./stretch-controller.js', import.meta.url),
  new URL('../worklets/stretch-processor.js', import.meta.url),
];

/** Highest rate we will ask an <audio> element for, before probing narrows it. */
export const NATIVE_RATE_CEILING = 4;

/** Rates the UI offers. The whole point of the exercise is the top of this list. */
export const RATE_PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10];

export const MIN_RATE = 0.25;
export const MAX_RATE = 10;

/** How much audio the worklet holds at once. 30s of stereo is about 11MB. */
const WINDOW_SECONDS = 30;
/** Keep a little audio behind the playhead so small seeks do not force a refill. */
const PREROLL_SECONDS = 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Find the highest playbackRate this browser accepts without clamping. Assigning
 * an out-of-range rate either throws or silently snaps to a different value.
 */
function probeNativeMaxRate(audio) {
  const previous = audio.playbackRate;
  let max = 1;
  for (const rate of [NATIVE_RATE_CEILING, 3, 2, 1.5, 1]) {
    try {
      audio.playbackRate = rate;
      if (Math.abs(audio.playbackRate - rate) < 1e-6) {
        max = rate;
        break;
      }
    } catch {
      // Rejected outright; try something slower.
    }
  }
  audio.playbackRate = previous;
  return max;
}

export class SpeedPlayer extends EventTarget {
  constructor(options = {}) {
    super();
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.audio.crossOrigin = 'anonymous';

    this.mode = 'auto'; // 'auto' | 'native' | 'wsola'
    this.engine = 'native';
    this.rate = 1;
    this.pitch = 0; // semitones
    this.volume = 1;
    this.frameSize = 2048;
    this.budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
    // Diagnostic escape hatch: force compressed-style whole-file decoding even
    // for formats that could stream.
    this.preferStreaming = options.preferStreaming !== false;

    this.file = null;
    this.track = null;
    this.objectURL = null;
    this.source = null;
    this.context = null;
    this.node = null;
    this.gain = null;
    this.workletReady = false;
    /** Set when the AudioWorklet could not be built and the fallback took over. */
    this.usingFallback = false;
    this.workletError = null;
    this.forceFallback = options.forceFallback === true;
    this.playing = false;
    this.decoding = false;
    this.buffering = false;

    /** Null when time-stretching is available; a reason string when it is not. */
    this.stretchBlockedReason = null;

    this.nativeMaxRate = probeNativeMaxRate(this.audio);
    this._position = 0;
    this._duration = 0;
    this._loadToken = 0;
    this._workletToken = -1;
    this._lastWindowStart = -1;
    this._windowBusy = false;
    this._switching = Promise.resolve();
    this._rafHandle = 0;

    this.audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(this.audio.duration)) {
        this._duration = this.audio.duration;
        this._emit('load');
      }
    });
    this.audio.addEventListener('ended', () => {
      if (this.engine === 'native') this._handleEnded();
    });
    this.audio.addEventListener('error', () => {
      if (!this.audio.src) return;
      this._emit('error', {
        message: `This browser could not decode ${this.track?.name ?? 'the selected file'}.`,
      });
    });
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------------------------------------------------------------- loading

  /**
   * Load an audio file.
   * @param {Blob} file
   * @param {{name?: string, path?: string}} [track] display metadata
   */
  async loadFile(file, track = {}) {
    this.stopTicker();
    this.playing = false;
    this._loadToken++;
    this._workletToken = -1;
    this._lastWindowStart = -1;
    this.source?.close();
    this.source = null;
    this.stretchBlockedReason = null;
    this.buffering = false;
    this._position = 0;
    this._duration = 0;
    this.file = file;
    this.track = { name: track.name ?? 'audio', path: track.path ?? track.name ?? '' };

    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.objectURL = URL.createObjectURL(file);
    this.audio.src = this.objectURL;
    this.audio.load();

    if (this.node) this.node.port.postMessage({ type: 'unload' });

    this._emit('load');
    this._emit('state');
  }

  /** Resolve once the element knows the track duration (or gives up). */
  waitForDuration(timeoutMs = 8000) {
    if (Number.isFinite(this.audio.duration)) return Promise.resolve(this.audio.duration);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.audio.removeEventListener('loadedmetadata', finish);
        this.audio.removeEventListener('error', finish);
        resolve(Number.isFinite(this.audio.duration) ? this.audio.duration : NaN);
      };
      const timer = setTimeout(finish, timeoutMs);
      this.audio.addEventListener('loadedmetadata', finish);
      this.audio.addEventListener('error', finish);
    });
  }

  /**
   * Build the reader for the current file: streaming where the format allows it,
   * a whole-file decode otherwise.
   */
  async ensureSource() {
    if (this.source) return this.source;
    if (!this.file) throw new Error('no file loaded');
    const token = this._loadToken;

    const durationHint = await this.waitForDuration();
    this.decoding = true;
    this._emit('decoding', { active: true, name: this.track?.name });
    try {
      const source = await createAudioSource(this.file, (rate) => this.ensureContext(rate), {
        durationHint,
        budgetBytes: this.budgetBytes,
        preferStreaming: this.preferStreaming,
      });
      if (token !== this._loadToken) {
        source.close();
        return this.source;
      }
      this.source = source;
      this._duration = source.duration;
      this.stretchBlockedReason = null;
      return source;
    } finally {
      this.decoding = false;
      this._emit('decoding', { active: false });
    }
  }

  /**
   * Whether the current file can be time-stretched at all, without committing to
   * a decode. Lets the UI cap the speed control before the user reaches for 10x.
   */
  async checkStretchSupport() {
    if (!this.file) return { available: false };
    const sampleRate = this.context?.sampleRate ?? 48000;
    const durationHint = await this.waitForDuration();
    const report = await inspectSource(this.file, {
      durationHint,
      sampleRate,
      budgetBytes: this.budgetBytes,
      preferStreaming: this.preferStreaming,
    });
    this.stretchBlockedReason = report.available
      ? null
      : this.describeBlock(report.estimatedBytes, report.budgetBytes);
    this._emit('capability', {
      available: report.available,
      streaming: report.streaming,
      reason: this.stretchBlockedReason,
    });
    return report;
  }

  describeBlock(estimatedBytes, budgetBytes) {
    const size = Number.isFinite(estimatedBytes) ? `about ${formatBytes(estimatedBytes)}` : 'more memory than is available';
    return (
      `Speeds above ${this.nativeMaxRate}x need this track decoded into memory, which would take ` +
      `${size} (the limit is ${formatBytes(budgetBytes)}). Uncompressed formats such as WAV stream ` +
      `instead and have no size limit.`
    );
  }

  async ensureContext(preferredSampleRate) {
    // Matching the context to the file's own rate avoids resampling a streamed
    // source, so a 44.1kHz WAV plays at its true pitch on a 48kHz device.
    if (this.context && preferredSampleRate && Math.abs(this.context.sampleRate - preferredSampleRate) > 1) {
      await this.teardownAudioGraph();
    }
    if (!this.context) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      try {
        this.context = preferredSampleRate ? new Ctor({ sampleRate: preferredSampleRate }) : new Ctor();
      } catch {
        this.context = new Ctor(); // device refused the rate; resampling it is
      }
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }

  async teardownAudioGraph() {
    this.node?.disconnect();
    if (this.node) this.node.onaudioprocess = null;
    this.node = null;
    this.workletReady = false;
    this.usingFallback = false;
    this._workletToken = -1;
    this._lastWindowStart = -1;
    const context = this.context;
    this.context = null;
    this.gain = null;
    await context?.close().catch(() => {});
  }

  /**
   * Source text for the worklet module. A bundled single-file build embeds it
   * (there are no separate files to fetch); otherwise the three classic scripts
   * are fetched and concatenated, because worklet modules with static imports
   * are not dependably supported.
   */
  async workletModuleSource() {
    if (typeof globalThis.__STRETCH_MODULE_SOURCE__ === 'string') {
      return globalThis.__STRETCH_MODULE_SOURCE__;
    }
    const parts = await Promise.all(MODULE_PARTS.map((url) => fetch(url).then((r) => r.text())));
    return parts.join('\n\n');
  }

  /**
   * Build the node that does the time-stretching. Prefers an AudioWorklet; falls
   * back to a main-thread ScriptProcessor when the worklet module cannot be
   * built — typically a Content-Security-Policy that forbids blob: scripts.
   * Without the fallback, every speed above the native ceiling would go silent.
   */
  async createStretchNode(context) {
    if (!this.forceFallback) {
      try {
        if (!this.workletReady) {
          const blob = new Blob([await this.workletModuleSource()], { type: 'text/javascript' });
          const url = URL.createObjectURL(blob);
          try {
            await context.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          this.workletReady = true;
        }
        return new AudioWorkletNode(context, 'wsola-stretch', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
      } catch (error) {
        this.workletError = error;
      }
    }

    const node = createFallbackNode(context);
    this.usingFallback = true;
    this._emit('fallback', {
      reason: this.forceFallback
        ? 'forced'
        : `AudioWorklet unavailable (${this.workletError?.message ?? 'unknown'})`,
    });
    return node;
  }

  async ensureWorklet() {
    const source = await this.ensureSource();
    const context = await this.ensureContext(source.sampleRate);

    if (!this.node) {
      this.node = await this.createStretchNode(context);
      this.node.port.onmessage = (event) => this._handleWorkletMessage(event.data);
      this.node.connect(this.gain);
    }

    if (this._workletToken !== this._loadToken) {
      this.node.port.postMessage({
        type: 'stream',
        totalFrames: source.totalFrames,
        channels: source.channels,
        sampleRate: source.sampleRate,
      });
      this._workletToken = this._loadToken;
      this._lastWindowStart = -1;
      this.node.port.postMessage({ type: 'seek', seconds: this._position });
      await this.sendWindow(Math.round(this._position * source.sampleRate), true);
    }

    return this.node;
  }

  // ------------------------------------------------------------ window pump

  get windowFrames() {
    return Math.round(WINDOW_SECONDS * (this.source?.sampleRate ?? 48000));
  }

  /**
   * How much unplayed window to keep in hand. At 10x a second of real time eats
   * ten seconds of audio, so the cushion has to scale with the rate.
   */
  get refillThresholdFrames() {
    const seconds = Math.max(5, this.rate * 1.5);
    return Math.round(seconds * (this.source?.sampleRate ?? 48000));
  }

  /** Read the window around `aroundFrame` and hand it to the worklet. */
  async sendWindow(aroundFrame, force = false) {
    if (!this.source || !this.node) return;
    const start = Math.max(0, Math.round(aroundFrame - PREROLL_SECONDS * this.source.sampleRate));
    if (this._windowBusy) return;
    if (!force && start === this._lastWindowStart) return;

    this._windowBusy = true;
    const token = this._loadToken;
    try {
      const channels = await this.source.readFrames(start, this.windowFrames);
      if (token !== this._loadToken || !this.node) return;
      const buffers = channels.map((channel) => channel.buffer);
      this.node.port.postMessage({ type: 'window', startFrame: start, channels: buffers }, buffers);
      this._lastWindowStart = start;
      if (this.buffering) {
        this.buffering = false;
        this._emit('buffering', { active: false });
      }
    } catch (error) {
      this._emit('error', { message: `Could not read audio: ${error.message}` });
    } finally {
      this._windowBusy = false;
    }
  }

  _handleWorkletMessage(message) {
    if (message.type === 'position') {
      this._position = message.seconds;
      if (message.duration) this._duration = message.duration;
      if (this.engine === 'wsola') this._emit('time');

      // Keep the worklet fed well before it runs dry.
      if (this.playing && this.source) {
        const remaining = message.windowEnd - message.positionFrames;
        const atEnd = message.windowEnd >= this.source.totalFrames;
        if (!atEnd && remaining < this.refillThresholdFrames) {
          void this.sendWindow(message.positionFrames);
        }
      }
    } else if (message.type === 'need') {
      // The stretcher ran dry — usually straight after a seek.
      if (!this.buffering) {
        this.buffering = true;
        this._emit('buffering', { active: true });
      }
      void this.sendWindow(message.from, true);
    } else if (message.type === 'ended') {
      if (this.engine === 'wsola') this._handleEnded();
    }
  }

  _handleEnded() {
    this.playing = false;
    this.stopTicker();
    this._emit('state');
    this._emit('ended');
  }

  // ---------------------------------------------------------------- engines

  /** Which engine the current settings call for. */
  desiredEngine() {
    if (this.mode === 'native') return 'native';
    if (this.stretchBlockedReason && this.mode === 'auto') return 'native';
    if (this.mode === 'wsola') return 'wsola';
    if (this.pitch !== 0) return 'wsola'; // native cannot shift pitch independently
    return this.rate <= this.nativeMaxRate ? 'native' : 'wsola';
  }

  /** Why the current engine is in use, for the UI to explain itself. */
  engineReason() {
    if (this.stretchBlockedReason && this.engine === 'native') return this.stretchBlockedReason;
    if (this.mode !== 'auto') return `forced to ${this.engine}`;
    if (this.engine === 'native') return `${this.nativeMaxRate}x or below — using the browser's own decoder`;
    if (this.pitch !== 0) return 'pitch is shifted, which needs time-stretching';
    const how = this.source?.streaming ? 'streamed in windows' : 'decoded into memory';
    const where = this.usingFallback ? 'on the main thread' : 'in an AudioWorklet';
    return `above ${this.nativeMaxRate}x — time-stretching ${where} (${how})`;
  }

  /** The fastest the current file can actually go. */
  get effectiveMaxRate() {
    return this.stretchBlockedReason ? this.nativeMaxRate : MAX_RATE;
  }

  /** Switch engines if the settings call for it, carrying position across. */
  async syncEngine() {
    this._switching = this._switching.then(() => this._syncEngineNow()).catch((error) => {
      this._emit('error', { message: error?.message ?? String(error) });
    });
    return this._switching;
  }

  async _syncEngineNow() {
    let target = this.desiredEngine();

    if (target === 'wsola') {
      // Committing to the worklet means committing to a source; if the file is
      // too big to decode, fall back rather than taking the tab down.
      try {
        await this.ensureSource();
      } catch (error) {
        if (error instanceof TooLargeToDecodeError) {
          this.stretchBlockedReason = this.describeBlock(error.estimatedBytes, error.budgetBytes);
          this._emit('capability', { available: false, reason: this.stretchBlockedReason });
          target = 'native';
        } else {
          throw error;
        }
      }
    }

    if (target === this.engine) {
      await this.applyParams();
      return;
    }

    const position = this.currentTime;
    const wasPlaying = this.playing;

    if (this.engine === 'native') this.audio.pause();
    else this.node?.port.postMessage({ type: 'pause' });

    if (target === 'wsola') {
      this._position = position;
      await this.ensureWorklet();
      this.node.port.postMessage({ type: 'seek', seconds: position });
      await this.sendWindow(Math.round(position * this.source.sampleRate), true);
    } else {
      this.node?.port.postMessage({ type: 'pause' });
      if (Number.isFinite(this.audio.duration)) this.audio.currentTime = position;
    }

    this.engine = target;
    this._position = position;
    await this.applyParams();
    this._emit('engine', { engine: target, reason: this.engineReason() });

    if (wasPlaying) {
      if (target === 'native') await this.audio.play().catch(() => {});
      else this.node.port.postMessage({ type: 'play' });
    }
  }

  async applyParams() {
    if (this.engine === 'native') {
      this.audio.preservesPitch = true;
      this.audio.mozPreservesPitch = true;
      this.audio.webkitPreservesPitch = true;
      this.audio.playbackRate = clamp(this.rate, MIN_RATE, this.nativeMaxRate);
      this.audio.volume = this.volume;
    } else if (this.node) {
      this.node.port.postMessage({
        type: 'params',
        speed: this.rate,
        pitchSemitones: this.pitch,
        frameSize: this.frameSize,
      });
      this.audio.volume = 0;
      if (this.gain) this.gain.gain.value = this.volume;
    }
  }

  // --------------------------------------------------------------- controls

  async play() {
    if (!this.file) return;
    await this.syncEngine();
    this.playing = true;
    if (this.engine === 'native') {
      try {
        await this.audio.play();
      } catch (error) {
        this.playing = false;
        this._emit('error', { message: error?.message ?? 'playback was blocked' });
      }
    } else {
      await this.ensureContext(this.source?.sampleRate);
      this.node.port.postMessage({ type: 'play' });
    }
    this._emit('state');
    this.startTicker();
  }

  pause() {
    this.playing = false;
    if (this.engine === 'native') this.audio.pause();
    else this.node?.port.postMessage({ type: 'pause' });
    this.stopTicker();
    this._emit('state');
  }

  async toggle() {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(seconds) {
    const target = clamp(seconds, 0, this.duration || 0);
    this._position = target;
    if (this.engine === 'native') {
      if (Number.isFinite(this.audio.duration)) this.audio.currentTime = target;
    } else if (this.node) {
      this.node.port.postMessage({ type: 'seek', seconds: target });
      if (this.source) void this.sendWindow(Math.round(target * this.source.sampleRate), true);
    }
    this._emit('time');
  }

  skip(deltaSeconds) {
    this.seek(this.currentTime + deltaSeconds);
  }

  async setRate(rate) {
    this.rate = clamp(rate, MIN_RATE, MAX_RATE);
    await this.syncEngine();
    this._emit('params');
  }

  async setPitch(semitones) {
    this.pitch = clamp(semitones, -12, 12);
    await this.syncEngine();
    this._emit('params');
  }

  async setMode(mode) {
    this.mode = mode;
    await this.syncEngine();
    this._emit('params');
  }

  async setFrameSize(frameSize) {
    this.frameSize = frameSize;
    await this.applyParams();
    this._emit('params');
  }

  setVolume(volume) {
    this.volume = clamp(volume, 0, 1);
    if (this.engine === 'native') this.audio.volume = this.volume;
    else if (this.gain) this.gain.gain.value = this.volume;
    this._emit('params');
  }

  get currentTime() {
    if (this.engine === 'native' && Number.isFinite(this.audio.currentTime)) return this.audio.currentTime;
    return this._position;
  }

  get duration() {
    if (this.source) return this.source.duration;
    if (Number.isFinite(this.audio.duration)) return this.audio.duration;
    return this._duration;
  }

  // The <audio> element only fires timeupdate a few times a second, which is too
  // coarse for a seek bar — especially at 10x, where a second of audio is gone
  // in 100ms.
  startTicker() {
    if (this._rafHandle) return;
    const tick = () => {
      if (!this.playing) {
        this._rafHandle = 0;
        return;
      }
      if (this.engine === 'native') this._position = this.audio.currentTime;
      this._emit('time');
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);
  }

  stopTicker() {
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    this._rafHandle = 0;
  }

  /** Memory the time-stretching engine needs for the current track. */
  describeMemory() {
    if (this.source?.streaming) {
      const bytes = this.windowFrames * this.source.channels * 4 * 2; // window + one in flight
      return { streaming: true, bytes };
    }
    if (this.source) return { streaming: false, bytes: this.source.decodedBytes };
    const duration = this.duration;
    if (!duration || !Number.isFinite(duration)) return null;
    const rate = this.context?.sampleRate ?? 48000;
    return { streaming: false, bytes: Math.round(duration * rate * 2 * 4) };
  }

  destroy() {
    this.stopTicker();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.source?.close();
    this.node?.disconnect();
    this.context?.close();
  }
}
