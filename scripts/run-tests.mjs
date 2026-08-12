/**
 * Minimal test runner: esbuild-bundles each tests/*.test.mjs (so the app's
 * extensionless TypeScript imports resolve) and runs it in Node.
 *
 * esbuild is already present as Vite's bundler, so this adds no install cost
 * and no test framework to learn.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'tests');
const outDir = mkdtempSync(join(tmpdir(), 'p2v-tests-'));

let failed = 0;
try {
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs'));
  for (const file of files) {
    console.log(`\n[1m${file}[0m`);
    const outfile = join(outDir, `${file}.bundle.mjs`);
    await build({
      entryPoints: [join(testDir, file)],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'error',
    });
    const run = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
    if (run.status !== 0) failed++;
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
