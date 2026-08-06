// End-to-end check: drive the real app in a real browser.
//
// The unit tests cover parsing and the DSP core, but not the parts that only
// exist in a browser — the AudioWorklet build, engine switching, decoding, the
// UI wiring. This walks the whole flow: open a torrent, attach its media,
// verify the piece hashes, then play at 10x and confirm the time-stretching
// engine takes over and audio actually advances.
//
//   node scripts/e2e.mjs
//
// Needs Playwright. Skips (exit 0) when it cannot be resolved.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    // Fall back to a global install.
    const globalRoot = (await run('npm', ['root', '-g'])).trim();
    ({ chromium } = require(join(globalRoot, 'playwright')));
  } catch {
    console.log('SKIP: playwright is not installed; run `npm i -D playwright` to enable the e2e check.');
    process.exit(0);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

const checks = [];
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const PORT = 8123 + (process.pid % 500);
let server;
let browser;
let fixtureDir;

try {
  fixtureDir = await mkdtemp(join(tmpdir(), 'tas-e2e-'));
  await run('node', [join(ROOT, 'test/fixtures/make-fixtures.mjs'), fixtureDir]);

  server = spawn('node', [join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => String(chunk).includes('running at') && resolve());
    server.on('error', reject);
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

  // 1. Read the torrent -----------------------------------------------------
  await page.setInputFiles('#torrent-input', join(fixtureDir, 'sample album.torrent'));
  await page.waitForSelector('#panel-meta:not([hidden])', { timeout: 5000 });

  check('torrent name is read', (await page.textContent('#torrent-name')) === 'sample album');

  const meta = await page.textContent('#meta-grid');
  const infoHash = /[0-9a-f]{40}/.exec(meta)?.[0] ?? '';
  check('info hash is computed', /^[0-9a-f]{40}$/.test(infoHash), infoHash);
  check('file count is listed', meta.includes('Files'), '');

  const rowCount = await page.locator('#file-rows tr').count();
  check('audio files are listed', rowCount === 2, `${rowCount} audio rows`);

  await page.uncheck('#audio-only');
  check('non-audio files appear when unfiltered', (await page.locator('#file-rows tr').count()) === 3);

  // 2. Attach the media and verify -----------------------------------------
  await page.setInputFiles('#files-input', [
    join(fixtureDir, 'sample album', '01 - low tone.wav'),
    join(fixtureDir, 'sample album', '02 - high tone.wav'),
    join(fixtureDir, 'sample album', 'notes.txt'),
  ]);
  await page.waitForSelector('#match-summary:not([hidden])');
  const matchText = await page.textContent('#match-summary');
  check('all three files are matched', matchText.includes('Matched 3 of 3'), matchText.trim());

  await page.click('#verify-button');
  await page.waitForFunction(
    () => document.getElementById('verify-status')?.textContent?.includes('verified'),
    null,
    { timeout: 20000 },
  );
  const verifyText = await page.textContent('#verify-status');
  check('every piece matches its hash', /^(\d+) of \1 checked/.test(verifyText.trim()), verifyText.trim());
  check('no piece failed', !verifyText.includes('failed'), verifyText.trim());

  const verifiedBadges = await page.locator('#file-rows .badge.ok').count();
  check('files are marked verified', verifiedBadges === 3, `${verifiedBadges} verified badges`);

  // 3. Play -----------------------------------------------------------------
  await page.waitForSelector('#panel-player:not([hidden])');
  const queued = await page.locator('#playlist li').count();
  check('audio queue is built', queued === 2, `${queued} tracks`);
  check('first track is selected', (await page.textContent('#track-title')) === '01 - low tone.wav');

  await page.click('#play-toggle');
  await page.waitForFunction(() => document.getElementById('play-toggle')?.textContent === 'Pause');
  check('native engine is used at 1x', (await page.textContent('#engine-badge')) === 'native');

  // The clock is formatted to whole seconds, so read the seek slider instead —
  // it is the finer-grained signal.
  await page.waitForTimeout(700);
  const nativePosition = Number(await page.inputValue('#seek'));
  check('playback advances at 1x', nativePosition > 0, `seek at ${nativePosition}/1000`);
  await page.click('#play-toggle'); // pause

  // 4. The actual point: 10x -----------------------------------------------
  await page.click('.preset.top'); // the 10x preset
  await page.waitForFunction(
    () => document.getElementById('engine-badge')?.textContent === 'time-stretch',
    null,
    { timeout: 20000 },
  );
  check('10x switches to the time-stretching engine', true, await page.getAttribute('#engine-badge', 'title'));
  check('speed reads 10x', (await page.textContent('#rate-value')) === '10x');

  // Play the 6-second track from the start and time how long it actually takes.
  // This is the claim the whole app rests on, so measure it rather than assume:
  // at 10x it must finish in about 0.6s of real time, and finishing is what
  // advances the queue to track two.
  await page.evaluate(() => {
    const seek = document.getElementById('seek');
    seek.value = '0';
    seek.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const startedAt = Date.now();
  await page.click('#play-toggle');
  await page.waitForFunction(
    () => document.getElementById('track-title')?.textContent === '02 - high tone.wav',
    null,
    { timeout: 15000 },
  );
  const elapsed = (Date.now() - startedAt) / 1000;
  check(
    'a 6s track plays through in roughly 0.6s at 10x',
    elapsed > 0.15 && elapsed < 3,
    `took ${elapsed.toFixed(2)}s (at 1x it would take 6s)`,
  );
  check('finishing advances the queue', (await page.textContent('#track-title')) === '02 - high tone.wav');

  // 5. Pitch is an independent control -------------------------------------
  await page.click('#play-toggle'); // pause
  await page.evaluate(() => {
    const pitch = document.getElementById('pitch');
    pitch.value = '5';
    pitch.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  check('pitch control reports semitones', (await page.textContent('#pitch-value')).includes('+5'));

  // 6. Magnet links ---------------------------------------------------------
  await page.fill('#magnet-input', `magnet:?xt=urn:btih:${infoHash}&dn=From+Magnet`);
  await page.click('#magnet-button');
  await page.waitForTimeout(300);
  check('magnet link is read', (await page.textContent('#torrent-name')) === 'From Magnet');
  check('magnet hides the file list it cannot know', await page.locator('#panel-files').isHidden());

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
} catch (error) {
  check('e2e run completed', false, error.message);
} finally {
  await browser?.close();
  server?.kill();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
