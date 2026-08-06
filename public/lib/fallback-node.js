// Main-thread stand-in for the AudioWorklet node.
//
// Building a worklet module needs a blob: URL, and some embedding contexts block
// those under Content-Security-Policy. Without a fallback, everything above the
// browser's native speed ceiling would silently go quiet — which is the entire
// feature. So when the worklet cannot be built, the same StretchController runs
// on the main thread behind a ScriptProcessorNode.
//
// The returned object mimics AudioWorkletNode closely enough that the player
// cannot tell the difference: same `port.postMessage` / `port.onmessage`
// protocol, same connect/disconnect.
//
// ScriptProcessorNode is deprecated and runs on the main thread, so it is more
// susceptible to glitching under load than the worklet. It is a fallback, not a
// preference.

/** Bigger buffers cost latency but survive main-thread jitter, which matters here. */
const BUFFER_FRAMES = 4096;

export function createFallbackNode(context) {
  const Controller = globalThis.StretchController;
  if (typeof Controller !== 'function') {
    throw new Error('StretchController is not loaded; the fallback engine needs it on the main thread');
  }

  // One input channel rather than zero: some browsers will not schedule a
  // ScriptProcessorNode that declares no inputs.
  const node = context.createScriptProcessor(BUFFER_FRAMES, 1, 2);
  let listener = null;

  const controller = new Controller(context.sampleRate, (message) => {
    listener?.({ data: message });
  });

  node.onaudioprocess = (event) => {
    const buffer = event.outputBuffer;
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));
    controller.render(channels, buffer.length);
  };

  node.port = {
    postMessage(message) {
      // The worklet receives transferred ArrayBuffers; here they arrive intact,
      // so the controller's `new Float32Array(buffer)` works unchanged.
      controller.handle(message);
    },
    set onmessage(fn) {
      listener = fn;
    },
    get onmessage() {
      return listener;
    },
  };

  node.isFallback = true;
  return node;
}
