// AudioWorkletProcessor wrapping the WSOLA stretcher.
//
// This file is not loaded on its own: player.js fetches wsola-core.js and this
// file, concatenates them, and hands the result to `audioWorklet.addModule` as a
// blob. So `WsolaStretcher` is already in scope here, and there is no import.

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
    this.reportInterval = Math.round(sampleRate / 20); // ~50ms
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'load': {
        const channels = message.channels.map((buffer) => new Float32Array(buffer));
        this.stretcher.setInput(channels, message.sampleRate || sampleRate);
        this.loaded = channels.length > 0 && channels[0].length > 0;
        this.playing = false;
        this.scratch = [];
        this.scratchFrames = 0;
        this.port.postMessage({
          type: 'loaded',
          duration: this.stretcher.durationFrames / this.stretcher.sampleRate,
          channels: this.stretcher.channels,
        });
        break;
      }
      case 'unload':
        this.loaded = false;
        this.playing = false;
        this.stretcher.setInput([], sampleRate);
        break;
      case 'play':
        if (this.loaded) {
          if (this.stretcher.finished) this.stretcher.seekFrames(0);
          this.playing = true;
        }
        break;
      case 'pause':
        this.playing = false;
        this.postPosition();
        break;
      case 'seek':
        this.stretcher.seekSeconds(message.seconds);
        this.postPosition();
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

  postPosition() {
    this.port.postMessage({
      type: 'position',
      seconds: this.stretcher.positionFrames / this.stretcher.sampleRate,
      duration: this.stretcher.durationFrames / this.stretcher.sampleRate,
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

    if (this.stretcher.finished) {
      this.playing = false;
      this.postPosition();
      this.port.postMessage({ type: 'ended' });
    }

    return true;
  }
}

registerProcessor('wsola-stretch', StretchProcessor);
