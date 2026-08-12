/**
 * Playback logic, exercised against a fake TTS engine.
 *
 * The point of keeping `Player` framework-free is that its timing logic — the
 * part that is genuinely fiddly — can be tested in Node in milliseconds,
 * including the cases that are painful to reproduce by hand: a voice that
 * never reports word boundaries, and an engine that keeps calling back after
 * being paused.
 */

// `Player` schedules with window.setTimeout; in Node they are the same timers.
globalThis.window = globalThis;

const { Player } = await import('../src/lib/player.ts');
const { tokenize } = await import('../src/lib/text/tokenize.ts');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <- ' + extra}`);
  if (!cond) failures++;
};

/** Engine that reports word boundaries, like desktop Chrome's local voices. */
function makeEngine({ boundaries = true, wordMs = 20 } = {}) {
  const engine = {
    id: 'fake', label: 'Fake', description: '',
    maxRate: 3, minRate: 0.5, emitsWordBoundaries: boundaries,
    spoken: [],
    _timers: [], _speaking: false, _paused: false, _voice: null, _rate: 1,
    isAvailable: () => true,
    getVoices: async () => [],
    setVoice(v) { this._voice = v; },
    getVoice() { return this._voice; },
    setRate(r) { this._rate = r; },
    isSpeaking() { return this._speaking; },
    isPaused() { return this._paused; },
    speak(text, handlers) {
      this.stop();
      this.spoken.push(text);
      this._speaking = true;
      let t = 0;
      if (boundaries) {
        const re = /\S+/g; let m;
        while ((m = re.exec(text))) {
          const charIndex = m.index;
          const charLength = m[0].length;
          t += wordMs;
          this._timers.push(setTimeout(() => handlers.onWordBoundary({ charIndex, charLength }), t));
        }
      } else {
        t = wordMs * (text.split(/\s+/).length);
      }
      this._timers.push(setTimeout(() => { this._speaking = false; handlers.onEnd(); }, t + wordMs));
    },
    pause() { this._paused = true; this._speaking = false; },
    resume() { this._paused = false; this._speaking = true; },
    stop() { this._timers.forEach(clearTimeout); this._timers = []; this._speaking = false; },
  };
  return engine;
}

const TEXT = 'The cat sat on the mat. The dog ran away quickly.\n\nA new paragraph begins here.';
const doc = tokenize(TEXT);

check('tokenizer: word count', doc.tokens.length === 16, doc.tokens.length);
check('tokenizer: three sentences', doc.sentences.length === 3, JSON.stringify(doc.sentences.map(s => TEXT.slice(s.start, s.end))));

// --- playback with real boundary events -----------------------------------
{
  const engine = makeEngine();
  const player = new Player(engine);
  player.setDocument(doc);
  const seen = [];
  player.subscribe((s) => seen.push(s.tokenIndex));
  player.play();
  await new Promise((r) => setTimeout(r, 900));

  check('reached the end', player.state.status === 'ended', player.state.status);
  check('highlighted every word in order',
    JSON.stringify([...new Set(seen)]) === JSON.stringify([...Array(16).keys()]),
    JSON.stringify([...new Set(seen)]));
  check('spoke one chunk per sentence', engine.spoken.length === 3, JSON.stringify(engine.spoken));
  player.destroy();
}

// --- estimator fallback (voice reports no boundaries) ----------------------
{
  const engine = makeEngine({ boundaries: false, wordMs: 120 });
  const player = new Player(engine);
  player.setDocument(doc);
  player.play();
  await new Promise((r) => setTimeout(r, 1800));
  check('estimator engaged', player.state.estimating === true);
  check('estimator advanced the highlight past word 0', player.state.tokenIndex > 0, player.state.tokenIndex);
  player.destroy();
}

// --- seeking ---------------------------------------------------------------
{
  const engine = makeEngine();
  const player = new Player(engine);
  player.setDocument(doc);

  player.seekToToken(8, false);
  check('tap-to-seek moves the word', player.state.tokenIndex === 8, player.state.tokenIndex);
  check('tap-to-seek moves the sentence', player.state.sentenceIndex === 1, player.state.sentenceIndex);

  player.previousSentence();
  check('skip back goes to the start of the current sentence', player.state.tokenIndex === 6, player.state.tokenIndex);
  player.previousSentence();
  check('skip back again goes to the previous sentence', player.state.tokenIndex === 0, player.state.tokenIndex);
  player.nextSentence();
  check('skip forward goes to the next sentence', player.state.tokenIndex === 6, player.state.tokenIndex);

  // Seeking mid-sentence must speak only the remainder of that sentence.
  player.seekToToken(8, true);
  await new Promise((r) => setTimeout(r, 30));
  check('mid-sentence seek speaks from that word', engine.spoken.at(-1).startsWith('ran away'), engine.spoken.at(-1));
  player.destroy();
}

// --- pause / resume --------------------------------------------------------
{
  const engine = makeEngine({ wordMs: 40 });
  const player = new Player(engine);
  player.setDocument(doc);
  player.play();
  await new Promise((r) => setTimeout(r, 120));
  const at = player.state.tokenIndex;
  player.pause();
  check('pause reports paused', player.state.status === 'paused', player.state.status);
  await new Promise((r) => setTimeout(r, 200));
  check('nothing advances while paused', player.state.tokenIndex === at, `${at} -> ${player.state.tokenIndex}`);
  player.play();
  check('resume reports playing', player.state.status === 'playing', player.state.status);
  player.destroy();
}

// --- rate changes are applied to the engine --------------------------------
{
  const engine = makeEngine();
  const player = new Player(engine);
  player.setDocument(doc);
  player.setRate(2.5);
  check('rate applied', engine._rate === 2.5, engine._rate);
  player.setRate(9);
  check('rate clamped to the engine maximum', player.state.rate === 3, player.state.rate);
  player.destroy();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
