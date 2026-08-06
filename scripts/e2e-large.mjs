// End-to-end check at real file sizes.
//
//   node scripts/e2e-large.mjs [fixtureDir] [megabytes]
//
// Generates (or reuses) a large WAV and its torrent, then verifies it, plays it
// at 10x, and seeks to the far end — while watching the browser's actual
// resident memory. The claim under test is that playback cost is bounded by the
// window, not by the file: a whole-file approach to a 100-minute track would
// need roughly 2GB of PCM before it could play a single sample.
//
// Needs Playwright. Skips (exit 0) when it cannot be resolved.

import { spawn } from 'node:child_process';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    const globalRoot = (await run('npm', ['root', '-g'])).trim();
    ({ chromium } = require(join(globalRoot, 'playwright')));
  } catch {
    console.log('SKIP: playwright is not installed; run `npm i -D playwright` to enable this check.');
    process.exit(0);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

const checks = [];
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------- process memory

/**
 * Total resident memory of every browser process, in bytes. Read straight from
 * /proc so it counts decoded audio buffers and worklet memory, which the
 * in-page JS heap figures do not.
 */
async function browserRss() {
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  let total = 0;
  for (const pid of pids) {
    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmdline.includes('pw-browsers')) continue;
      // Proportional set size, not RSS: Chromium's processes share a lot of
      // memory, and summing RSS across them counts those pages once per process.
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => null);
      const match = rollup
        ? /^Pss:\s+(\d+) kB/m.exec(rollup)
        : /VmRSS:\s+(\d+) kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
      if (match) total += Number(match[1]) * 1024;
    } catch {
      /* process exited between the listing and the read */
    }
  }
  return total;
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

/** Memory readings taken at each stage, so growth can be attributed. */
const stages = [];
async function mark(label) {
  const bytes = await browserRss();
  stages.push({ label, bytes });
  return bytes;
}
function stageBytes(label) {
  return stages.find((entry) => entry.label === label)?.bytes ?? 0;
}

// ------------------------------------------------------------------ run

const PORT = 8623 + (process.pid % 300);
const fixtureDir = process.argv[2] ?? join(ROOT, 'fixtures-large');
const megabytes = Number(process.argv[3] ?? 1024);

let server;
let browser;

try {
  await mkdir(fixtureDir, { recursive: true });
  const existing = (await readdir(fixtureDir)).find((name) => name.endsWith('.wav.torrent'));
  if (!existing) {
    console.log(`Generating a ${megabytes}MB fixture (one-off, takes a minute)…`);
    await run('node', [join(ROOT, 'test/fixtures/make-large-fixture.mjs'), fixtureDir, String(megabytes)]);
  }

  const torrentName = (await readdir(fixtureDir)).find((name) => name.endsWith('.wav.torrent'));
  const wavName = torrentName.replace(/\.torrent$/, '');
  const wavPath = join(fixtureDir, wavName);
  const wavSize = (await stat(wavPath)).size;
  console.log(`Using ${wavName} (${gb(wavSize)})\n`);

  server = spawn('node', [join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => String(chunk).includes('running at') && resolve());
    setTimeout(() => reject(new Error('server did not start')), 10000);
  });

  browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await mark('page loaded');

  // 1. Read the torrent -----------------------------------------------------
  await page.setInputFiles('#torrent-input', join(fixtureDir, torrentName));
  await page.waitForSelector('#panel-meta:not([hidden])', { timeout: 20000 });
  const meta = await page.textContent('#meta-grid');
  check('a 1GB torrent parses', meta.includes('GiB') || meta.includes('MiB'), meta.match(/[\d.]+ [GM]iB/)?.[0]);

  // 2. Attach and verify ----------------------------------------------------
  await page.setInputFiles('#files-input', [wavPath]);
  await page.waitForSelector('#match-summary:not([hidden])', { timeout: 30000 });
  check('the large file is matched', (await page.textContent('#match-summary')).includes('Matched 1 of 1'));

  const verifyStart = Date.now();
  await page.click('#verify-button');
  await page.waitForFunction(
    () => document.getElementById('verify-status')?.textContent?.includes('verified'),
    null,
    { timeout: 300000 },
  );
  const verifySeconds = (Date.now() - verifyStart) / 1000;
  const verifyText = (await page.textContent('#verify-status')).trim();
  check('every piece of a 1GB file verifies', /^(\d+) of \1 checked/.test(verifyText), verifyText);
  await mark('verified');
  check(
    'verification streams rather than loading the file',
    // A fixed budget, not a proportion of the file: the whole point is that
    // this number does not track file size.
    stageBytes('verified') - stageBytes('page loaded') < 300e6,
    `+${mb(stageBytes('verified') - stageBytes('page loaded'))} for a ${gb(wavSize)} file, ` +
      `${verifySeconds.toFixed(1)}s at ${(wavSize / 1e6 / verifySeconds).toFixed(0)} MB/s`,
  );

  // 3. Play at 10x ----------------------------------------------------------
  await page.waitForSelector('#panel-player:not([hidden])', { timeout: 20000 });
  const durationText = await page.textContent('#time-total');
  const shownSeconds = durationText
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
  const expectedSeconds = (wavSize - 44) / (44100 * 2 * 2);
  check(
    'duration is read from the header, not by decoding',
    Math.abs(shownSeconds - expectedSeconds) < 2,
    `${durationText} of audio (header says ${Math.round(expectedSeconds)}s)`,
  );

  await page.click('.preset.top'); // 10x
  await page.waitForFunction(
    () => document.getElementById('engine-badge')?.textContent === 'time-stretch',
    null,
    { timeout: 30000 },
  );
  check('10x is offered on a 1GB file', true, await page.getAttribute('#engine-badge', 'title'));

  await mark('before play');
  const playStart = Date.now();
  await page.click('#play-toggle');
  // A whole-file approach would have to decode ~2GB of PCM before the first
  // sample; streaming should be audible almost immediately.
  await page.waitForFunction(() => Number(document.getElementById('seek').value) > 0, null, { timeout: 30000 });
  const timeToAudio = (Date.now() - playStart) / 1000;
  check('playback starts without decoding the file', timeToAudio < 5, `first audio after ${timeToAudio.toFixed(2)}s`);

  const readPosition = () =>
    page.evaluate(() => {
      const [minutes, seconds] = document.getElementById('time-current').textContent.split(':').slice(-2);
      return Number(minutes) * 60 + Number(seconds);
    });

  const before = await readPosition();
  await page.waitForTimeout(4000);
  const after = await readPosition();
  const advanced = after - before;
  check(
    'audio really advances at about 10x',
    advanced > 25 && advanced < 55,
    `${advanced}s of audio in 4s of real time`,
  );

  const playingRss = await mark('playing at 10x');
  // The invariant: playing costs a window plus the audio graph, whatever the
  // file size. Anything proportional to the file would blow straight past this.
  const playbackCost = playingRss - stageBytes('before play');
  check(
    'playing at 10x costs a window, not a file',
    playbackCost < 250e6,
    `+${mb(playbackCost)} to play a ${gb(wavSize)} file at 10x`,
  );

  // 4. Random access far into the file --------------------------------------
  await page.evaluate(() => {
    const seek = document.getElementById('seek');
    seek.value = '950'; // ~95% in
    seek.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const seekStart = Date.now();
  await page.waitForFunction(
    () => {
      const text = document.getElementById('time-current').textContent;
      const [m] = text.split(':');
      return Number(m) >= 1; // past the first hour
    },
    null,
    { timeout: 20000 },
  );
  const seekSeconds = (Date.now() - seekStart) / 1000;
  check('seeking 95 minutes in is immediate', seekSeconds < 5, `${seekSeconds.toFixed(2)}s`);

  const afterSeek = await readPosition();
  await page.waitForTimeout(3000);
  check('playback continues from the far end', (await readPosition()) > afterSeek, 'position kept advancing');

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  await mark('after seeking to 95%');
  console.log('\nbrowser memory by stage:');
  let previous = 0;
  for (const entry of stages) {
    const delta = previous ? ` (${entry.bytes >= previous ? '+' : ''}${mb(entry.bytes - previous)})` : '';
    console.log(`  ${entry.label.padEnd(22)} ${gb(entry.bytes)}${delta}`);
    previous = entry.bytes;
  }
} catch (error) {
  check('large-file run completed', false, error.message);
} finally {
  await browser?.close();
  server?.kill();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
