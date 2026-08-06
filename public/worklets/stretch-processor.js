// AudioWorkletProcessor around StretchController.
//
// This file is not loaded on its own: player.js concatenates wsola-core.js,
// stretch-controller.js and this file into one module and hands the result to
// `audioWorklet.addModule` as a blob. So both classes are already in scope, and
// there is no import.
//
// All the real work lives in StretchController, which the main-thread fallback
// drives too — keeping this wrapper thin is what stops the two hosts diverging.

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global inside AudioWorkletGlobalScope.
    this.controller = new StretchController(sampleRate, (message, transfer) =>
      this.port.postMessage(message, transfer ?? []),
    );
    this.port.onmessage = (event) => this.controller.handle(event.data);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    this.controller.render(output, output[0].length);
    return true;
  }
}

registerProcessor('wsola-stretch', StretchProcessor);
