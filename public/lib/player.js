// Variable-speed audio player with two interchangeable engines.
//
//   native — an <audio> element with `playbackRate` + `preservesPitch`. Streams
//            straight off disk, costs nothing, sounds good. But browsers only
//            reliably honour a modest range and quietly clamp or mute past it,
//            so we probe the real ceiling and never push it.
//
//   wsola  — the audio decoded into memory and time-stretched by our own
//            AudioWorklet. Costs a decode and the RAM to hold PCM, but reaches
//            10x (and beyond) on any browser with AudioWorklet, and makes pitch
//            an independent control instead of a side effect of speed.
//
// `auto` picks native while it is safely in range and switches to wsola when the
// requested speed exceeds it, or when pitch is shifted at all. Switching hands
// the playback position across so it is inaudible apart from the decode pause
// the first time.

const CORE_URL = new URL('./wsola-core.js', import.meta.url);
const PROCESSOR_URL = new URL('../worklets/stretch-processor.js', import.meta.url);

/** Highest rate we will ask an <audio> element for, before probing narrows it. */
export const NATIVE_RATE_CEILING = 4;

/** Rates the UI offers. The whole point of the exercise is the top of this list. */
export const RATE_PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10];

export const MIN_RATE = 0.25;
export const MAX_RATE = 10;

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
  constructor() {
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

    this.file = null;
    this.track = null;
    this.objectURL = null;
    this.buffer = null;
    this.context = null;
    this.node = null;
    this.gain = null;
    this.workletReady = false;
    this.playing = false;
    this.decoding = false;

    this.nativeMaxRate = probeNativeMaxRate(this.audio);
    this._position = 0;
    this._duration = 0;
    this._loadToken = 0;
    this._workletToken = -1;
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
    this.buffer = null;
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

  /** Decode the current file to PCM. Required by the wsola engine. */
  async ensureDecoded() {
    if (this.buffer) return this.buffer;
    if (!this.file) throw new Error('no file loaded');
    const token = this._loadToken;
    const context = await this.ensureContext();

    this.decoding = true;
    this._emit('decoding', { active: true, name: this.track?.name });
    try {
      const bytes = await this.file.arrayBuffer();
      const buffer = await context.decodeAudioData(bytes);
      if (token !== this._loadToken) return this.buffer; // a different file was loaded meanwhile
      this.buffer = buffer;
      this._duration = buffer.duration;
      return buffer;
    } finally {
      this.decoding = false;
      this._emit('decoding', { active: false });
    }
  }

  async ensureContext() {
    if (!this.context) {
      this.context = new (window.AudioContext ?? window.webkitAudioContext)();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }

  /**
   * Build the worklet module. The DSP core and the processor are fetched and
   * concatenated into one blob because worklet modules with static imports are
   * not dependably supported.
   */
  async ensureWorklet() {
    const context = await this.ensureContext();

    if (!this.workletReady) {
      const [core, processor] = await Promise.all([
        fetch(CORE_URL).then((r) => r.text()),
        fetch(PROCESSOR_URL).then((r) => r.text()),
      ]);
      const blob = new Blob([core, '\n\n', processor], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.workletReady = true;
    }

    if (!this.node) {
      this.node = new AudioWorkletNode(context, 'wsola-stretch', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.node.port.onmessage = (event) => this._handleWorkletMessage(event.data);
      this.node.connect(this.gain);
    }

    if (this._workletToken !== this._loadToken) {
      const buffer = await this.ensureDecoded();
      const token = this._loadToken;
      const channels = [];
      const transfers = [];
      for (let ch = 0; ch < Math.min(buffer.numberOfChannels, 2); ch++) {
        const copy = new Float32Array(buffer.getChannelData(ch));
        channels.push(copy.buffer);
        transfers.push(copy.buffer);
      }
      this.node.port.postMessage(
        { type: 'load', channels, sampleRate: buffer.sampleRate },
        transfers,
      );
      this._workletToken = token;
      this.node.port.postMessage({ type: 'seek', seconds: this._position });
    }

    return this.node;
  }

  _handleWorkletMessage(message) {
    if (message.type === 'position') {
      this._position = message.seconds;
      if (message.duration) this._duration = message.duration;
      if (this.engine === 'wsola') this._emit('time');
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
    if (this.mode === 'wsola') return 'wsola';
    if (this.pitch !== 0) return 'wsola'; // native cannot shift pitch independently
    return this.rate <= this.nativeMaxRate ? 'native' : 'wsola';
  }

  /** Why the current engine is in use, for the UI to explain itself. */
  engineReason() {
    if (this.mode !== 'auto') return `forced to ${this.engine}`;
    if (this.engine === 'native') return `${this.nativeMaxRate}x or below — using the browser's own decoder`;
    if (this.pitch !== 0) return 'pitch is shifted, which needs time-stretching';
    return `above ${this.nativeMaxRate}x — time-stretching in an AudioWorklet`;
  }

  /** Switch engines if the settings call for it, carrying position across. */
  async syncEngine() {
    this._switching = this._switching.then(() => this._syncEngineNow()).catch((error) => {
      this._emit('error', { message: error?.message ?? String(error) });
    });
    return this._switching;
  }

  async _syncEngineNow() {
    const target = this.desiredEngine();
    if (target === this.engine) {
      await this.applyParams();
      return;
    }

    const position = this.currentTime;
    const wasPlaying = this.playing;

    if (this.engine === 'native') this.audio.pause();
    else this.node?.port.postMessage({ type: 'pause' });

    if (target === 'wsola') {
      await this.ensureWorklet();
      this.node.port.postMessage({ type: 'seek', seconds: position });
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
      await this.ensureContext();
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
    } else {
      this.node?.port.postMessage({ type: 'seek', seconds: target });
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
    if (this.buffer) return this.buffer.duration;
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

  /** Rough PCM footprint of decoding the current file, for a size warning. */
  estimateDecodedBytes() {
    const duration = this.duration;
    if (!duration || !Number.isFinite(duration)) return 0;
    const rate = this.context?.sampleRate ?? 48000;
    return Math.round(duration * rate * 2 * 4); // stereo float32
  }

  destroy() {
    this.stopTicker();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.node?.disconnect();
    this.context?.close();
  }
}
