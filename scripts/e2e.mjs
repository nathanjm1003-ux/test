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
  const pageErrors = [];
  const watch = (target) => {
    target.on('pageerror', (error) => pageErrors.push(String(error)));
    target.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    return target;
  };

  /** Open the app with the fixture torrent and its audio already attached. */
  const openWithFixture = async (query = '') => {
    const target = watch(await browser.newPage());
    await target.goto(`http://127.0.0.1:${PORT}/${query}`);
    await target.setInputFiles('#torrent-input', join(fixtureDir, 'sample album.torrent'));
    await target.waitForSelector('#panel-meta:not([hidden])', { timeout: 5000 });
    await target.setInputFiles('#files-input', [
      join(fixtureDir, 'sample album', '01 - low tone.wav'),
      join(fixtureDir, 'sample album', '02 - high tone.wav'),
    ]);
    await target.waitForSelector('#panel-player:not([hidden])', { timeout: 10000 });
    return target;
  };

  const page = watch(await browser.newPage());
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

  // 7. The whole-file decode path, which every compressed format uses --------
  const decodePage = await openWithFixture('?noStream=1');
  await decodePage.click('.preset.top');
  await decodePage.waitForFunction(
    () => document.getElementById('engine-badge')?.textContent === 'time-stretch',
    null,
    { timeout: 20000 },
  );
  const decodeStart = Date.now();
  await decodePage.click('#play-toggle');
  await decodePage.waitForFunction(
    () => document.getElementById('track-title')?.textContent === '02 - high tone.wav',
    null,
    { timeout: 20000 },
  );
  const decodeElapsed = (Date.now() - decodeStart) / 1000;
  check(
    'the decode path reaches 10x too',
    decodeElapsed > 0.15 && decodeElapsed < 4,
    `6s track took ${decodeElapsed.toFixed(2)}s`,
  );
  check(
    'the decode path says it decoded rather than streamed',
    (await decodePage.getAttribute('#engine-badge', 'title')).includes('decoded into memory'),
  );
  await decodePage.close();

  // 8. A track too large to decode ------------------------------------------
  const cappedPage = await openWithFixture('?noStream=1&decodeBudgetMB=1');
  await cappedPage.waitForFunction(() => !document.getElementById('rate-note')?.hidden, null, { timeout: 10000 });
  const note = await cappedPage.textContent('#rate-note');
  check('a track too large to decode explains the cap', note.includes('need this track decoded'), note.slice(0, 80));
  check('presets past the cap are disabled', await cappedPage.locator('.preset.top').isDisabled());
  check('presets within the cap stay usable', await cappedPage.locator('.preset[data-rate="2"]').isEnabled());

  // It must still play — just not faster than the native engine manages.
  await cappedPage.click('.preset[data-rate="2"]');
  await cappedPage.click('#play-toggle');
  await cappedPage.waitForTimeout(600);
  check(
    'an oversized track still plays on the native engine',
    Number(await cappedPage.inputValue('#seek')) > 0,
    `engine: ${await cappedPage.textContent('#engine-badge')}`,
  );
  await cappedPage.close();

  // 9. The main-thread fallback, for contexts that forbid blob: worklets ------
  const fallbackPage = await openWithFixture('?fallback=1');
  await fallbackPage.click('.preset.top');
  await fallbackPage.waitForFunction(
    () => document.getElementById('engine-badge')?.textContent === 'time-stretch',
    null,
    { timeout: 20000 },
  );
  check(
    'the fallback engine reports where it runs',
    (await fallbackPage.getAttribute('#engine-badge', 'title')).includes('main thread'),
    await fallbackPage.getAttribute('#engine-badge', 'title'),
  );

  const fallbackStart = Date.now();
  await fallbackPage.click('#play-toggle');
  await fallbackPage.waitForFunction(
    () => document.getElementById('track-title')?.textContent === '02 - high tone.wav',
    null,
    { timeout: 20000 },
  );
  const fallbackElapsed = (Date.now() - fallbackStart) / 1000;
  check(
    'the fallback engine also reaches 10x',
    fallbackElapsed > 0.15 && fallbackElapsed < 4,
    `6s track took ${fallbackElapsed.toFixed(2)}s without an AudioWorklet`,
  );
  await fallbackPage.close();

  // 10. Audio with no torrent at all ----------------------------------------
  const directPage = watch(await browser.newPage());
  await directPage.goto(`http://127.0.0.1:${PORT}/`);
  await directPage.setInputFiles('#audio-input', [
    join(fixtureDir, 'sample album', '02 - high tone.wav'),
    join(fixtureDir, 'sample album', '01 - low tone.wav'),
  ]);
  await directPage.waitForSelector('#panel-player:not([hidden])', { timeout: 10000 });
  check('audio files play without a torrent', (await directPage.locator('#playlist li').count()) === 2);
  check(
    'the queue is sorted, not left in pick order',
    (await directPage.textContent('#track-title')) === '01 - low tone.wav',
  );
  check('torrent-only panels stay out of the way', await directPage.locator('#panel-attach').isHidden());
  check(
    'step numbers disappear when the steps were skipped',
    await directPage.locator('#panel-player .step').isHidden(),
  );

  await directPage.click('.preset.top');
  await directPage.waitForFunction(
    () => document.getElementById('engine-badge')?.textContent === 'time-stretch',
    null,
    { timeout: 20000 },
  );
  const directStart = Date.now();
  await directPage.click('#play-toggle');
  await directPage.waitForFunction(
    () => document.getElementById('track-title')?.textContent === '02 - high tone.wav',
    null,
    { timeout: 20000 },
  );
  const directElapsed = (Date.now() - directStart) / 1000;
  check(
    'a plain audio file reaches 10x',
    directElapsed > 0.15 && directElapsed < 4,
    `6s track took ${directElapsed.toFixed(2)}s with no torrent`,
  );
  await directPage.close();

  // 11. MP3: the reported bug, and the compressed path it lands on -----------
  const mp3Page = watch(await browser.newPage());
  await mp3Page.goto(`http://127.0.0.1:${PORT}/`);

  // The bug: the dropzone advertised audio but its picker only accepted
  // torrents, so an MP3 could not be selected at all.
  const accept = await mp3Page.getAttribute('#torrent-input', 'accept');
  check('the dropzone picker accepts audio, not just torrents', /audio|mp3/.test(accept), accept);

  await mp3Page.setInputFiles('#torrent-input', join(fixtureDir, 'sample.mp3'));
  await mp3Page.waitForSelector('#panel-player:not([hidden])', { timeout: 10000 });
  check('an mp3 chosen through the dropzone loads', (await mp3Page.textContent('#track-title')) === 'sample.mp3');
  check('no error is shown for a valid mp3', await mp3Page.locator('#load-error').isHidden());

  await mp3Page.waitForFunction(() => document.getElementById('time-total')?.textContent !== '0:00', null, {
    timeout: 10000,
  });
  check('mp3 duration is read', (await mp3Page.textContent('#time-total')) === '0:05', await mp3Page.textContent('#time-total'));

  await mp3Page.click('#play-toggle');
  await mp3Page.waitForTimeout(600);
  check('an mp3 plays', Number(await mp3Page.inputValue('#seek')) > 0, `engine: ${await mp3Page.textContent('#engine-badge')}`);
  await mp3Page.click('#play-toggle');

  // Compressed audio has to be decoded whole, so this exercises the path WAV
  // never takes.
  await mp3Page.click('.preset.top');
  await mp3Page.waitForFunction(
    () => document.getElementById('engine-badge')?.textContent === 'time-stretch',
    null,
    { timeout: 20000 },
  );
  check(
    'an mp3 reaches 10x via the decode path',
    (await mp3Page.getAttribute('#engine-badge', 'title')).includes('decoded into memory'),
    await mp3Page.getAttribute('#engine-badge', 'title'),
  );
  await mp3Page.close();

  // An mp3 dropped rather than picked must behave the same way.
  const dropPage = watch(await browser.newPage());
  await dropPage.goto(`http://127.0.0.1:${PORT}/`);
  await dropPage.setInputFiles('#audio-input', [join(fixtureDir, 'sample.mp3')]);
  await dropPage.waitForSelector('#panel-player:not([hidden])', { timeout: 10000 });
  check('the dedicated audio picker takes mp3 too', (await dropPage.textContent('#track-title')) === 'sample.mp3');
  await dropPage.close();

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
