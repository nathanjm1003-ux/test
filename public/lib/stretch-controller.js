// Everything that sits between the WSOLA DSP and an audio callback: message
// handling, the sliding-window protocol, position reporting.
//
// It is separate from the AudioWorklet processor because it has to run in two
// places. Normally it lives on the audio thread inside the worklet. But building
// a worklet module needs a blob: URL, and some embedding contexts forbid those
// under Content-Security-Policy — so there is also a main-thread fallback
// (fallback-node.js) that drives this exact same controller through a
// ScriptProcessorNode. One implementation, two hosts, no protocol drift.
//
// CLASSIC SCRIPT, like wsola-core.js: it is concatenated into the worklet module
// at runtime, and loaded as a plain <script> for the fallback. `WsolaStretcher`
// is expected to already be in scope.

class StretchController {
  /**
   * @param {number} sampleRate
   * @param {(message: object, transfer?: Transferable[]) => void} post
   */
  constructor(sampleRate, post) {
    this.stretcher = new WsolaStretcher({ sampleRate });
    this.post = post;
    this.loaded = false;
    this.playing = false;
    this.scratch = [];
    this.scratchFrames = 0;
    this.framesSinceReport = 0;
    this.framesSinceNeed = 0;
    this.reportInterval = Math.round(sampleRate / 20); // ~50ms
  }

  handle(message) {
    switch (message.type) {
      case 'stream': {
        this.stretcher.setStream({
          totalFrames: message.totalFrames,
          channels: message.channels,
          sampleRate: message.sampleRate || this.stretcher.sampleRate,
        });
        this.loaded = message.totalFrames > 0 && message.channels > 0;
        this.playing = false;
        this.scratch = [];
        this.scratchFrames = 0;
        this.post({
          type: 'ready',
          duration: this.stretcher.durationFrames / this.stretcher.sampleRate,
          channels: this.stretcher.channels,
        });
        break;
      }
      case 'window':
        this.stretcher.setWindow(
          message.channels.map((buffer) => new Float32Array(buffer)),
          message.startFrame,
        );
        break;
      case 'unload':
        this.loaded = false;
        this.playing = false;
        this.stretcher.setStream({ totalFrames: 0, channels: 0, sampleRate: this.stretcher.sampleRate });
        break;
      case 'play':
        if (this.loaded) {
          if (this.stretcher.finished) this.stretcher.seekFrames(0);
          this.playing = true;
          this.requestWindow(); // in case the window is stale after a seek
        }
        break;
      case 'pause':
        this.playing = false;
        this.postPosition();
        break;
      case 'seek':
        this.stretcher.seekSeconds(message.seconds);
        this.postPosition();
        this.requestWindow();
        break;
      case 'params':
        if (typeof message.speed === 'number') this.stretcher.setSpeed(message.speed);
        if (typeof message.pitchSemitones === 'number') this.stretcher.setPitchSemitones(message.pitchSemitones);
        if (typeof message.frameSize === 'number' && message.frameSize !== this.stretcher.frameSize) {
          this.stretcher.setFrameSize(message.frameSize);
        }
        break;
      default:
        break;
    }
  }

  /** Ask the supplier for the window covering the playhead. */
  requestWindow() {
    this.post({
      type: 'need',
      from: this.stretcher.neededFrom,
      to: this.stretcher.neededTo,
      position: this.stretcher.positionFrames,
    });
  }

  postPosition() {
    const s = this.stretcher;
    this.post({
      type: 'position',
      seconds: s.positionFrames / s.sampleRate,
      duration: s.durationFrames / s.sampleRate,
      positionFrames: s.positionFrames,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      stalled: s.stalled,
    });
  }

  ensureScratch(frames) {
    const channels = this.stretcher.channels;
    if (this.scratchFrames === frames && this.scratch.length === channels) return;
    this.scratch = Array.from({ length: channels }, () => new Float32Array(frames));
    this.scratchFrames = frames;
  }

  /**
   * Fill an audio callback's output.
   * @param {Float32Array[]} output one array per output channel
   * @param {number} frames
   */
  render(output, frames) {
    if (!this.loaded || !this.playing) {
      for (const channel of output) channel.fill(0);
      return;
    }

    this.ensureScratch(frames);
    this.stretcher.pull(this.scratch, frames);

    const sourceChannels = this.scratch.length;
    for (let ch = 0; ch < output.length; ch++) {
      // Mono sources feed both outputs.
      output[ch].set(this.scratch[Math.min(ch, sourceChannels - 1)]);
    }

    this.framesSinceReport += frames;
    if (this.framesSinceReport >= this.reportInterval) {
      this.framesSinceReport = 0;
      this.postPosition();
    }

    // Ran out of window: chase the supplier, but not on every callback.
    if (this.stretcher.stalled) {
      this.framesSinceNeed += frames;
      if (this.framesSinceNeed >= this.reportInterval) {
        this.framesSinceNeed = 0;
        this.requestWindow();
      }
    } else {
      this.framesSinceNeed = this.reportInterval;
    }

    if (this.stretcher.finished) {
      this.playing = false;
      this.postPosition();
      this.post({ type: 'ended' });
    }
  }
}

// Same reason as wsola-core.js: make the class reachable from module scope.
globalThis.StretchController = StretchController;
