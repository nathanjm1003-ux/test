// WSOLA time-stretcher (Waveform Similarity Overlap-Add).
//
// Why this exists: an <audio> element's `playbackRate` is the cheap way to speed
// audio up, but browsers only guarantee a modest range and clamp or mute beyond
// it. This decouples speed from pitch ourselves, so 10x is reachable everywhere
// AudioWorklet is, and pitch becomes an independent control rather than a
// side effect of speed.
//
// How it works: the signal is cut into overlapping Hann-windowed frames and
// overlap-added back together at a *different* hop than they were taken from.
// Output hop Hs is fixed; analysis hop Ha = Hs * timeFactor. Playing 10x faster
// means stepping 10x further through the input per frame while emitting the same
// number of samples. The "WS" part is the fix for the artefacts that naive
// overlap-add produces: before laying a frame down, we search +/- searchRadius
// samples around the ideal position for the offset whose waveform best
// correlates with the tail we already committed, so successive frames stay in
// phase.
//
// Pitch is layered on top: to shift pitch by ratio p while holding speed s, we
// time-stretch by s/p and resample the result by p. Resampling scales duration
// by 1/p, so the two compose back to exactly s.
//
// MEMORY: the stretcher never holds the whole track. Each synthesis step touches
// only [k0 - searchRadius, k0 + searchRadius + frameSize) — under 60ms of audio —
// so it works over a sliding *window* that somebody else keeps supplying. Whole
// files are just the degenerate case of a window covering everything (see
// setInput). That is what lets a 1GB file play at 10x in a few tens of MB: see
// `neededFrom`/`neededTo`, which tell the supplier what to send next, and
// `stalled`, which says the window ran dry.
//
// This file is a CLASSIC SCRIPT on purpose — no import/export. It is
// concatenated into the AudioWorklet module at runtime (worklet module loading
// with static imports is not dependable across browsers) and loaded directly by
// the unit tests. Keep it dependency-free.

class WsolaStretcher {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.searchRadius = options.searchRadius ?? 256;
    this.baseTemplateSize = options.templateSize ?? 512;
    this.searchStep = options.searchStep ?? 1;

    this.channels = 0;

    // The window currently available to read from, and where it sits in the
    // track. windowStart is a frame index into the whole track.
    this.window = [];
    this.windowStart = 0;
    this.windowLength = 0;
    this.totalFrames = 0;

    this.speed = 1;
    this.pitchRatio = 1;

    this.inPos = 0;
    this.frac = 0;
    this.qStart = 0;
    this.qLen = 0;
    this.hasTemplate = false;
    this.ended = false;
    this.stalled = false;

    this._configureFrame(options.frameSize ?? 2048);
  }

  /** Time-stretch factor applied to the input; pitch is handled by resampling. */
  get timeFactor() {
    return this.speed / this.pitchRatio;
  }

  get durationFrames() {
    return this.totalFrames;
  }

  /**
   * Playback position in input frames. `inPos` runs ahead of what the listener
   * has heard by whatever is still sitting in the output queue, so subtract it.
   */
  get positionFrames() {
    return Math.max(0, Math.min(this.totalFrames, this.inPos - this.qLen * this.timeFactor));
  }

  /** True once the track is exhausted and the queue has drained. */
  get finished() {
    return this.ended && this.qLen < 2;
  }

  /** First frame the next synthesis step needs. */
  get neededFrom() {
    return Math.max(0, Math.round(this.inPos) - this.searchRadius);
  }

  /** One past the last frame the next synthesis step needs. */
  get neededTo() {
    return Math.min(this.totalFrames, Math.round(this.inPos) + this.searchRadius + this.frameSize);
  }

  get windowEnd() {
    return this.windowStart + this.windowLength;
  }

  /** Whether the loaded window can satisfy [from, to). */
  covers(from, to) {
    return this.windowLength > 0 && from >= this.windowStart && to <= this.windowEnd;
  }

  _configureFrame(frameSize) {
    const size = Math.max(128, Math.round(frameSize / 2) * 2);
    this.frameSize = size;
    this.hop = size / 2;
    // The template must fit inside one hop, or it describes audio the next
    // frame does not actually overlap.
    this.templateSize = Math.min(this.baseTemplateSize, this.hop);

    // Periodic Hann. At 50% overlap w[n] + w[n + N/2] === 1, so the overlap-add
    // reconstructs unity gain without a normalisation pass.
    this.window_ = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.window_[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
    }

    this.template = new Float32Array(this.templateSize);
    this.queueCapacity = Math.max(this.hop * 8, 8192);
    this._allocateChannels();
  }

  _allocateChannels() {
    this.acc = [];
    this.queue = [];
    for (let ch = 0; ch < this.channels; ch++) {
      this.acc.push(new Float32Array(this.hop));
      this.queue.push(new Float32Array(this.queueCapacity));
    }
    this.qStart = 0;
    this.qLen = 0;
    this.frac = 0;
    this.hasTemplate = false;
  }

  /**
   * Install a whole track at once. Equivalent to declaring a stream and handing
   * over a window that covers all of it.
   * @param {Float32Array[]} channelData one array per channel, all the same length
   * @param {number} [sampleRate]
   */
  setInput(channelData, sampleRate) {
    const length = channelData.length ? channelData[0].length : 0;
    this.setStream({ totalFrames: length, channels: channelData.length, sampleRate });
    if (length > 0) this.setWindow(channelData, 0);
    this.seekFrames(0);
  }

  /**
   * Declare a track that will be fed window by window.
   * @param {{totalFrames:number, channels:number, sampleRate?:number}} info
   */
  setStream({ totalFrames, channels, sampleRate }) {
    this.totalFrames = totalFrames;
    this.channels = channels;
    if (sampleRate) this.sampleRate = sampleRate;
    this.window = [];
    this.windowStart = 0;
    this.windowLength = 0;
    this._allocateChannels();
    this.seekFrames(0);
  }

  /**
   * Supply the audio for [startFrame, startFrame + length). Replaces whatever
   * window was loaded before.
   * @param {Float32Array[]} channelData
   * @param {number} startFrame frame index within the whole track
   */
  setWindow(channelData, startFrame) {
    this.window = channelData;
    this.windowStart = startFrame;
    this.windowLength = channelData.length ? channelData[0].length : 0;
    if (this.windowLength > 0) this.stalled = false;
  }

  /** Change frame size mid-playback (larger = smoother, smaller = tighter transients). */
  setFrameSize(frameSize) {
    const position = this.inPos;
    const window = this.window;
    const windowStart = this.windowStart;
    const windowLength = this.windowLength;
    this._configureFrame(frameSize);
    this.window = window;
    this.windowStart = windowStart;
    this.windowLength = windowLength;
    this.seekFrames(position);
  }

  setSpeed(speed) {
    this.speed = Math.min(32, Math.max(0.05, speed));
  }

  setPitchRatio(ratio) {
    this.pitchRatio = Math.min(4, Math.max(0.25, ratio));
  }

  setPitchSemitones(semitones) {
    this.setPitchRatio(Math.pow(2, semitones / 12));
  }

  seekSeconds(seconds) {
    this.seekFrames(Math.round(seconds * this.sampleRate));
  }

  seekFrames(frame) {
    this.inPos = Math.min(this.totalFrames, Math.max(0, frame));
    this.qStart = 0;
    this.qLen = 0;
    this.frac = 0;
    this.hasTemplate = false;
    this.ended = this.inPos >= this.totalFrames;
    this.stalled = false;
    for (let ch = 0; ch < this.channels; ch++) this.acc[ch].fill(0);
  }

  /** Make room for `need` more frames, compacting or growing the queue as required. */
  _ensureQueueSpace(need) {
    if (this.qStart + this.qLen + need <= this.queueCapacity) return;

    if (this.qLen + need > this.queueCapacity) {
      const capacity = Math.max(this.queueCapacity * 2, this.qLen + need);
      for (let ch = 0; ch < this.channels; ch++) {
        const grown = new Float32Array(capacity);
        grown.set(this.queue[ch].subarray(this.qStart, this.qStart + this.qLen), 0);
        this.queue[ch] = grown;
      }
      this.queueCapacity = capacity;
    } else {
      for (let ch = 0; ch < this.channels; ch++) {
        this.queue[ch].copyWithin(0, this.qStart, this.qStart + this.qLen);
      }
    }
    this.qStart = 0;
  }

  /** Read one frame of the track, or 0 outside the loaded window. */
  _at(channel, frame) {
    const i = frame - this.windowStart;
    return i >= 0 && i < this.windowLength ? this.window[channel][i] : 0;
  }

  /**
   * Search around `k0` for the offset whose waveform best matches the tail we
   * already committed. Normalised cross-correlation, computed on channel 0 —
   * one channel is enough to lock the phase, and applying the same offset to
   * every channel is what keeps the stereo image intact.
   */
  _findBestOffset(k0) {
    const template = this.template;
    const size = this.templateSize;
    const x = this.window[0];
    const base = this.windowStart;
    const limit = Math.min(this.totalFrames, this.windowEnd);

    let lo = -this.searchRadius;
    let hi = this.searchRadius;
    if (k0 + lo < Math.max(0, this.windowStart)) lo = Math.max(0, this.windowStart) - k0;
    if (k0 + hi + size > limit) hi = limit - size - k0;
    if (hi < lo) return 0;

    let best = 0;
    let bestScore = -Infinity;
    for (let d = lo; d <= hi; d += this.searchStep) {
      const start = k0 + d - base;
      let correlation = 0;
      let energy = 0;
      for (let i = 0; i < size; i++) {
        const v = x[start + i];
        correlation += template[i] * v;
        energy += v * v;
      }
      const score = correlation / Math.sqrt(energy + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best;
  }

  /**
   * Produce one hop of stretched output.
   * @returns {boolean} false when the track is spent or the window ran dry
   */
  _synthesizeStep() {
    if (this.inPos >= this.totalFrames) {
      this.ended = true;
      return false;
    }
    // Everything this step will touch must already be in the window.
    if (!this.covers(this.neededFrom, this.neededTo)) {
      this.stalled = true;
      return false;
    }
    this.stalled = false;

    const N = this.frameSize;
    const H = this.hop;
    const total = this.totalFrames;
    const shape = this.window_;

    const k0 = Math.round(this.inPos);
    const offset = this.hasTemplate ? this._findBestOffset(k0) : 0;
    const start = Math.max(0, k0 + offset);

    this._ensureQueueSpace(H);
    const writeAt = this.qStart + this.qLen;

    // Fast path: the whole frame sits inside the window, so index directly.
    const base = start - this.windowStart;
    const direct = base >= 0 && base + N <= this.windowLength && start + N <= total;

    for (let ch = 0; ch < this.channels; ch++) {
      const x = this.window[ch];
      const acc = this.acc[ch];
      const q = this.queue[ch];
      if (direct) {
        for (let i = 0; i < H; i++) q[writeAt + i] = acc[i] + x[base + i] * shape[i];
        for (let i = 0; i < H; i++) acc[i] = x[base + H + i] * shape[H + i];
      } else {
        for (let i = 0; i < H; i++) {
          const frame = start + i;
          q[writeAt + i] = acc[i] + (frame < total ? this._at(ch, frame) * shape[i] : 0);
        }
        for (let i = 0; i < H; i++) {
          const frame = start + H + i;
          acc[i] = frame < total ? this._at(ch, frame) * shape[H + i] : 0;
        }
      }
    }
    this.qLen += H;

    // The next frame should continue from here, so this is what we match against.
    const templateStart = start + H;
    for (let i = 0; i < this.templateSize; i++) {
      const frame = templateStart + i;
      this.template[i] = frame < total ? this._at(0, frame) : 0;
    }
    this.hasTemplate = true;

    // Advance the ideal pointer by the analysis hop, independent of the offset
    // we chose, so search corrections never accumulate into drift.
    this.inPos += H * this.timeFactor;
    return true;
  }

  /**
   * Fill `outputs` with `frameCount` frames of audio.
   * @param {Float32Array[]} outputs one array per channel, at least frameCount long
   * @returns {number} frames of real audio written (the rest is silence)
   */
  pull(outputs, frameCount) {
    const channels = this.channels;
    let produced = 0;

    for (let f = 0; f < frameCount; f++) {
      // Keep enough queued to interpolate and to absorb a pitch-ratio stride.
      while (this.qLen < 8 && this._synthesizeStep()) {
        /* fill */
      }
      if (this.qLen < 2) {
        for (let ch = 0; ch < channels; ch++) outputs[ch][f] = 0;
        continue;
      }

      const i = this.qStart;
      const t = this.frac;
      for (let ch = 0; ch < channels; ch++) {
        const q = this.queue[ch];
        outputs[ch][f] = q[i] * (1 - t) + q[i + 1] * t;
      }
      produced++;

      this.frac += this.pitchRatio;
      const advance = Math.floor(this.frac);
      if (advance > 0) {
        this.frac -= advance;
        const step = Math.min(advance, this.qLen);
        this.qStart += step;
        this.qLen -= step;
      }
    }

    return produced;
  }
}

// A class declaration in a classic script is a lexical binding, not a property
// of globalThis. Publish it so module code can reach it — the fallback engine
// needs this class on the main thread.
globalThis.WsolaStretcher = WsolaStretcher;
