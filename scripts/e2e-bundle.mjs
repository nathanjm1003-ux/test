// Verify the single-file bundle actually works.
//
//   node scripts/bundle.mjs dist/torrent-audio.html --standalone
//   node scripts/e2e-bundle.mjs [bundleFile]
//
// Bundling changes how the app loads itself — flattened modules, inlined classic
// scripts, an embedded worklet source instead of a fetched one — so it needs
// checking on its own rather than assuming the multi-file version's results
// carry over. Both engines are exercised, because a published page may sit under
// a Content-Security-Policy that forbids the blob: URL the worklet needs.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
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
    const globalRoot = (await run('npm', ['root', '-g'])).trim();
    ({ chromium } = require(join(globalRoot, 'playwright')));
  } catch {
    console.log('SKIP: playwright is not installed.');
    process.exit(0);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
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

const bundlePath = process.argv[2] ?? join(ROOT, 'dist/torrent-audio.html');
const PORT = 8790 + (process.pid % 200);

let server;
let browser;
let fixtureDir;

try {
  const bundle = await readFile(bundlePath, 'utf8');
  check('bundle is one self-contained file', !/src=["']\.?\//.test(bundle) && !/<link\b/.test(bundle),
    `${(Buffer.byteLength(bundle) / 1024).toFixed(0)} KB, no external references`);
  check('worklet source travels with the page', bundle.includes('__STRETCH_MODULE_SOURCE__'));

  fixtureDir = await mkdtemp(join(tmpdir(), 'tas-bundle-'));
  await run('node', [join(ROOT, 'test/fixtures/make-fixtures.mjs'), fixtureDir]);

  // Serve the single file at every path; it has no assets to resolve.
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(bundle);
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

  const runFlow = async (query, label) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

    // Nothing may be fetched: a published page may be unable to reach anything.
    const requests = [];
    page.on('request', (request) => {
      if (request.url() !== `http://127.0.0.1:${PORT}/${query}` && !request.url().startsWith('blob:')) {
        requests.push(request.url());
      }
    });

    await page.goto(`http://127.0.0.1:${PORT}/${query}`);
    await page.setInputFiles('#torrent-input', join(fixtureDir, 'sample album.torrent'));
    await page.waitForSelector('#panel-meta:not([hidden])', { timeout: 10000 });
    check(`${label}: torrent parses`, (await page.textContent('#torrent-name')) === 'sample album');

    await page.setInputFiles('#files-input', [
      join(fixtureDir, 'sample album', '01 - low tone.wav'),
      join(fixtureDir, 'sample album', '02 - high tone.wav'),
    ]);
    await page.waitForSelector('#panel-player:not([hidden])', { timeout: 10000 });

    await page.click('#verify-button');
    await page.waitForFunction(
      () => document.getElementById('verify-status')?.textContent?.includes('verified'),
      null,
      { timeout: 30000 },
    );
    const verifyText = (await page.textContent('#verify-status')).trim();
    check(`${label}: pieces verify`, /^(\d+) of \1 checked/.test(verifyText), verifyText);

    await page.click('.preset.top');
    await page.waitForFunction(
      () => document.getElementById('engine-badge')?.textContent === 'time-stretch',
      null,
      { timeout: 20000 },
    );

    const started = Date.now();
    await page.click('#play-toggle');
    await page.waitForFunction(
      () => document.getElementById('track-title')?.textContent === '02 - high tone.wav',
      null,
      { timeout: 20000 },
    );
    const elapsed = (Date.now() - started) / 1000;
    check(
      `${label}: 6s track plays through at 10x`,
      elapsed > 0.15 && elapsed < 4,
      `${elapsed.toFixed(2)}s — ${await page.getAttribute('#engine-badge', 'title')}`,
    );

    check(`${label}: no network requests`, requests.length === 0, requests.slice(0, 3).join(', '));
    check(`${label}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
    await page.close();
  };

  await runFlow('', 'worklet');
  // The path a restrictive CSP would force the page down.
  await runFlow('?fallback=1', 'fallback');
} catch (error) {
  check('bundle run completed', false, error.message);
} finally {
  await browser?.close();
  server?.close();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
