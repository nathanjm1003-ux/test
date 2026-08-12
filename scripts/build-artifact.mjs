/**
 * Folds the artifact build into one self-contained HTML fragment.
 *
 * The publishing host wraps the file in its own <!doctype>/<head>/<body>, so
 * this emits only the page content: <title>, an inline <style>, the mount
 * point, and an inline module <script>. No external requests, which is exactly
 * what a published page's CSP allows.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'dist-artifact', 'assets');

const files = await readdir(assets);
const css = files.find((f) => f.endsWith('.css'));
const js = files.find((f) => f.endsWith('.js'));
if (!css || !js) throw new Error('Build output is missing its CSS or JS — run vite build first.');

/** A literal </style> or </script> inside the payload would close the tag early. */
const escape = (source, tag) =>
  source.replaceAll(`</${tag}`, `<\\/${tag}`);

const styles = await readFile(join(assets, css), 'utf8');
const script = await readFile(join(assets, js), 'utf8');

const out = `<title>Page to Voice</title>
<style>
${escape(styles, 'style')}
</style>
<div id="root"></div>
<script type="module">
${escape(script, 'script')}
</script>
`;

const target = join(root, 'dist-artifact', 'page-to-voice.html');
await writeFile(target, out);
console.log(
  `artifact: ${target} (${(Buffer.byteLength(out) / 1024).toFixed(0)} kB)`,
);
