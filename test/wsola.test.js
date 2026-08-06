import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWsola, renderAll, sine, zeroCrossingRate, rms } from './helpers.js';

const SAMPLE_RATE = 48000;
const WsolaStretcher = await loadWsola();

function stretcherFor(channels, options = {}) {
  const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE, ...options });
  stretcher.setInput(channels, SAMPLE_RATE);
  return stretcher;
}

/**
 * Output length is quantised to whole synthesis hops, so allow one hop of slack
 * on top of a small proportional tolerance.
 */
function assertLength(actual, ideal, hop, label) {
  const slack = hop + ideal * 0.02;
  assert.ok(
    Math.abs(actual - ideal) <= slack,
    `${label}: expected about ${Math.round(ideal)} frames, got ${actual} (tolerance ${Math.round(slack)})`,
  );
}

test('passes audio through at 1x with the length and level intact', () => {
  const input = sine(440, 1);
  const stretcher = stretcherFor([input]);
  stretcher.setSpeed(1);

  const output = renderAll(stretcher);
  assertLength(output.length, input.length, stretcher.hop, '1x');
  assert.ok(Math.abs(rms(output) - rms(input)) < 0.06, `level drifted: ${rms(output)} vs ${rms(input)}`);
});

test('compresses time by the requested factor', () => {
  for (const speed of [2, 4, 10]) {
    const input = sine(440, 2);
    const stretcher = stretcherFor([input]);
    stretcher.setSpeed(speed);

    const output = renderAll(stretcher);
    assertLength(output.length, input.length / speed, stretcher.hop, `${speed}x`);
  }
});

test('holds pitch steady all the way to 10x — the whole point of the exercise', () => {
  const input = sine(440, 2);
  const reference = zeroCrossingRate(input);

  for (const speed of [1, 2, 5, 10]) {
    const stretcher = stretcherFor([sine(440, 2)]);
    stretcher.setSpeed(speed);
    const output = renderAll(stretcher);

    // Trim the Hann fade-in and the ragged tail before measuring.
    const body = output.subarray(stretcher.hop, Math.max(stretcher.hop + 1, output.length - stretcher.hop));
    const measured = zeroCrossingRate(body);
    const drift = Math.abs(measured - reference) / reference;
    assert.ok(drift < 0.1, `at ${speed}x the pitch drifted ${(drift * 100).toFixed(1)}%`);
  }
});

test('keeps a usable signal level at high speed', () => {
  const input = sine(440, 2);
  const stretcher = stretcherFor([input]);
  stretcher.setSpeed(10);
  const output = renderAll(stretcher);
  const body = output.subarray(stretcher.hop, output.length - stretcher.hop);

  // Phase cancellation between overlapped frames is exactly what the waveform
  // similarity search exists to prevent, so the level must survive.
  assert.ok(rms(body) > rms(input) * 0.7, `output collapsed to ${rms(body)} from ${rms(input)}`);
});

test('shifts pitch independently of speed', () => {
  const input = sine(440, 1);
  const reference = zeroCrossingRate(input);

  const stretcher = stretcherFor([sine(440, 1)]);
  stretcher.setSpeed(1);
  stretcher.setPitchSemitones(12); // one octave up
  const output = renderAll(stretcher);

  // An octave up at unchanged speed: twice the crossings, same duration.
  const body = output.subarray(stretcher.hop, output.length - stretcher.hop);
  const ratio = zeroCrossingRate(body) / reference;
  assert.ok(Math.abs(ratio - 2) < 0.2, `expected roughly double the pitch, got ${ratio.toFixed(2)}x`);
  assertLength(output.length, input.length, stretcher.hop, 'pitch shift at 1x');
});

test('combines a pitch shift with a speed change', () => {
  const input = sine(440, 2);
  const stretcher = stretcherFor([input]);
  stretcher.setSpeed(4);
  stretcher.setPitchSemitones(-12); // one octave down
  const output = renderAll(stretcher);

  // Pitch is handled by resampling, but speed must still come out at 4x.
  assertLength(output.length, input.length / 4, stretcher.hop, '4x with pitch down');
  const body = output.subarray(stretcher.hop, output.length - stretcher.hop);
  const ratio = zeroCrossingRate(body) / zeroCrossingRate(input);
  assert.ok(Math.abs(ratio - 0.5) < 0.1, `expected half the pitch, got ${ratio.toFixed(2)}x`);
});

test('handles stereo, applying the same alignment to both channels', () => {
  const left = sine(440, 1);
  const right = sine(440, 1, SAMPLE_RATE, 0.25); // same wave, quieter
  const stretcher = stretcherFor([left, right]);
  stretcher.setSpeed(6);

  const block = 256;
  const scratch = [new Float32Array(block), new Float32Array(block)];
  let checked = 0;
  while (!stretcher.finished && checked < 20) {
    const produced = stretcher.pull(scratch, block);
    if (!produced) break;
    checked++;
    // The channels must stay phase-locked, or the stereo image would smear.
    for (let i = 0; i < produced; i++) {
      if (Math.abs(scratch[0][i]) > 0.05) {
        assert.ok(
          Math.abs(scratch[1][i] * 2 - scratch[0][i]) < 0.05,
          'channels drifted out of alignment',
        );
      }
    }
  }
  assert.ok(checked > 0);
});

test('reports position and duration in input time, not output time', () => {
  const stretcher = stretcherFor([sine(440, 4)]);
  stretcher.setSpeed(8);
  assert.equal(stretcher.durationFrames, 4 * SAMPLE_RATE);

  const scratch = [new Float32Array(128)];
  for (let i = 0; i < 100; i++) stretcher.pull(scratch, 128);

  // 100 blocks of output at 8x covers roughly 100 * 128 * 8 input frames.
  const expected = 100 * 128 * 8;
  const drift = Math.abs(stretcher.positionFrames - expected) / expected;
  assert.ok(drift < 0.15, `position ${stretcher.positionFrames} strayed from ${expected}`);
});

test('seeks, resumes and finishes cleanly', () => {
  const stretcher = stretcherFor([sine(440, 4)]);
  stretcher.setSpeed(2);

  stretcher.seekSeconds(3);
  assert.equal(stretcher.positionFrames, 3 * SAMPLE_RATE);
  assert.equal(stretcher.finished, false);

  const output = renderAll(stretcher);
  assertLength(output.length, SAMPLE_RATE / 2, stretcher.hop, 'one second left at 2x');
  assert.equal(stretcher.finished, true);

  // Seeking backwards must revive a finished stretcher.
  stretcher.seekSeconds(0);
  assert.equal(stretcher.finished, false);
});

test('seeking past the end finishes rather than hanging', () => {
  const stretcher = stretcherFor([sine(440, 1)]);
  stretcher.seekSeconds(99);
  const output = renderAll(stretcher, 48000);
  assert.equal(output.length, 0);
  assert.equal(stretcher.finished, true);
});

test('survives input shorter than one frame', () => {
  const stretcher = stretcherFor([sine(440, 0.005)]); // 240 frames, frame size 2048
  stretcher.setSpeed(10);
  const output = renderAll(stretcher, 48000);
  assert.ok(output.length >= 0);
  assert.equal(stretcher.finished, true);
});

test('changing frame size mid-stream keeps the position', () => {
  const stretcher = stretcherFor([sine(440, 2)]);
  stretcher.setSpeed(3);
  const scratch = [new Float32Array(128)];
  for (let i = 0; i < 40; i++) stretcher.pull(scratch, 128);

  const before = stretcher.positionFrames;
  stretcher.setFrameSize(4096);
  assert.equal(stretcher.frameSize, 4096);
  assert.equal(stretcher.hop, 2048);
  assert.ok(Math.abs(stretcher.positionFrames - before) < 4096);

  const output = renderAll(stretcher);
  assert.ok(output.length > 0);
});

test('clamps absurd speed and pitch requests', () => {
  const stretcher = stretcherFor([sine(440, 0.5)]);
  stretcher.setSpeed(1000);
  assert.equal(stretcher.speed, 32);
  stretcher.setSpeed(0);
  assert.equal(stretcher.speed, 0.05);
  stretcher.setPitchRatio(99);
  assert.equal(stretcher.pitchRatio, 4);
});

test('keeps the template inside one hop when the frame is small', () => {
  const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE, frameSize: 512, templateSize: 512 });
  stretcher.setInput([sine(440, 0.5)], SAMPLE_RATE);
  assert.equal(stretcher.hop, 256);
  assert.equal(stretcher.templateSize, 256);
  stretcher.setSpeed(10);
  assert.ok(renderAll(stretcher).length > 0);
});
