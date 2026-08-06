// AudioWorkletProcessor wrapping the WSOLA stretcher.
//
// This file is not loaded on its own: player.js fetches wsola-core.js and this
// file, concatenates them, and hands the result to `audioWorklet.addModule` as a
// blob. So `WsolaStretcher` is already in scope here, and there is no import.
//
// The processor holds only a sliding window of the track, never the whole
// thing — `process()` is synchronous and cannot await a decode, so the main
// thread supplies windows ahead of the playhead. Every position report carries
// the frame range the stretcher will need next, and running dry posts a `need`
// so the supplier can catch up immediately.

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global inside AudioWorkletGlobalScope.
    this.stretcher = new WsolaStretcher({ sampleRate });
    this.loaded = false;
    this.playing = false;
    this.scratch = [];
    this.scratchFrames = 0;
    this.framesSinceReport = 0;
    this.framesSinceNeed = 0;
    this.reportInterval = Math.round(sampleRate / 20); // ~50ms
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'stream': {
        this.stretcher.setStream({
          totalFrames: message.totalFrames,
          channels: message.channels,
          sampleRate: message.sampleRate || sampleRate,
        });
        this.loaded = message.totalFrames > 0 && message.channels > 0;
        this.playing = false;
        this.scratch = [];
        this.scratchFrames = 0;
        this.port.postMessage({
          type: 'ready',
          duration: this.stretcher.durationFrames / this.stretcher.sampleRate,
          channels: this.stretcher.channels,
        });
        break;
      }
      case 'window': {
        this.stretcher.setWindow(
          message.channels.map((buffer) => new Float32Array(buffer)),
          message.startFrame,
        );
        break;
      }
      case 'unload':
        this.loaded = false;
        this.playing = false;
        this.stretcher.setStream({ totalFrames: 0, channels: 0, sampleRate });
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

  /** Ask the main thread for the window covering the playhead. */
  requestWindow() {
    this.port.postMessage({
      type: 'need',
      from: this.stretcher.neededFrom,
      to: this.stretcher.neededTo,
      position: this.stretcher.positionFrames,
    });
  }

  postPosition() {
    const s = this.stretcher;
    this.port.postMessage({
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

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;

    if (!this.loaded || !this.playing) {
      for (const channel of output) channel.fill(0);
      return true;
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

    // Ran out of window: chase the supplier, but not on every render quantum.
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
      this.port.postMessage({ type: 'ended' });
    }

    return true;
  }
}

registerProcessor('wsola-stretch', StretchProcessor);
