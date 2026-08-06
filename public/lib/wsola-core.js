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
    this.input = [];
    this.inputLength = 0;

    this.speed = 1;
    this.pitchRatio = 1;

    this.inPos = 0;
    this.frac = 0;
    this.qStart = 0;
    this.qLen = 0;
    this.hasTemplate = false;
    this.ended = false;

    this._configureFrame(options.frameSize ?? 2048);
  }

  /** Time-stretch factor applied to the input; pitch is handled by resampling. */
  get timeFactor() {
    return this.speed / this.pitchRatio;
  }

  get durationFrames() {
    return this.inputLength;
  }

  /**
   * Playback position in input frames. `inPos` runs ahead of what the listener
   * has heard by whatever is still sitting in the output queue, so subtract it.
   */
  get positionFrames() {
    return Math.max(0, Math.min(this.inputLength, this.inPos - this.qLen * this.timeFactor));
  }

  /** True once the input is exhausted and the queue has drained. */
  get finished() {
    return this.ended && this.qLen < 2;
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
    this.window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
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
   * Install the audio to play.
   * @param {Float32Array[]} channelData one array per channel, all the same length
   * @param {number} [sampleRate]
   */
  setInput(channelData, sampleRate) {
    this.input = channelData;
    this.channels = channelData.length;
    this.inputLength = channelData.length ? channelData[0].length : 0;
    if (sampleRate) this.sampleRate = sampleRate;
    this._allocateChannels();
    this.seekFrames(0);
  }

  /** Change frame size mid-playback (larger = smoother, smaller = tighter transients). */
  setFrameSize(frameSize) {
    const position = this.inPos;
    this._configureFrame(frameSize);
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
    this.inPos = Math.min(this.inputLength, Math.max(0, frame));
    this.qStart = 0;
    this.qLen = 0;
    this.frac = 0;
    this.hasTemplate = false;
    this.ended = this.inPos >= this.inputLength;
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

  /**
   * Search around `k0` for the offset whose waveform best matches the tail we
   * already committed. Normalised cross-correlation, computed on channel 0 —
   * one channel is enough to lock the phase, and applying the same offset to
   * every channel is what keeps the stereo image intact.
   */
  _findBestOffset(k0) {
    const template = this.template;
    const size = this.templateSize;
    const x = this.input[0];
    const length = this.inputLength;

    let lo = -this.searchRadius;
    let hi = this.searchRadius;
    if (k0 + lo < 0) lo = -k0;
    if (k0 + hi + size > length) hi = length - size - k0;
    if (hi < lo) return 0;

    let best = 0;
    let bestScore = -Infinity;
    for (let d = lo; d <= hi; d += this.searchStep) {
      const base = k0 + d;
      let correlation = 0;
      let energy = 0;
      for (let i = 0; i < size; i++) {
        const v = x[base + i];
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

  /** Produce one hop of stretched output. Returns false when the input is spent. */
  _synthesizeStep() {
    if (this.inPos >= this.inputLength) {
      this.ended = true;
      return false;
    }

    const N = this.frameSize;
    const H = this.hop;
    const length = this.inputLength;
    const window = this.window;

    const k0 = Math.round(this.inPos);
    const offset = this.hasTemplate ? this._findBestOffset(k0) : 0;
    const start = Math.max(0, k0 + offset);

    this._ensureQueueSpace(H);
    const writeAt = this.qStart + this.qLen;
    const withinBounds = start + N <= length;

    for (let ch = 0; ch < this.channels; ch++) {
      const x = this.input[ch];
      const acc = this.acc[ch];
      const q = this.queue[ch];
      if (withinBounds) {
        for (let i = 0; i < H; i++) q[writeAt + i] = acc[i] + x[start + i] * window[i];
        for (let i = 0; i < H; i++) acc[i] = x[start + H + i] * window[H + i];
      } else {
        for (let i = 0; i < H; i++) {
          const j = start + i;
          q[writeAt + i] = acc[i] + (j < length ? x[j] * window[i] : 0);
        }
        for (let i = 0; i < H; i++) {
          const j = start + H + i;
          acc[i] = j < length ? x[j] * window[H + i] : 0;
        }
      }
    }
    this.qLen += H;

    // The next frame should continue from here, so this is what we match against.
    const x0 = this.input[0];
    const templateStart = start + H;
    for (let i = 0; i < this.templateSize; i++) {
      const j = templateStart + i;
      this.template[i] = j < length ? x0[j] : 0;
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
