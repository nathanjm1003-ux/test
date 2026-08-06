// Bundle the app into a single self-contained HTML file.
//
//   node scripts/bundle.mjs [outFile] [--standalone]
//
// The app normally runs as separate ES modules plus two classic scripts, and
// builds its AudioWorklet by fetching those scripts at runtime. None of that
// survives being reduced to one file, so this:
//
//   - inlines the stylesheet,
//   - inlines the two classic scripts (the DSP and its controller),
//   - embeds the worklet module's source as a string, so the player has
//     something to build a blob from without fetching anything,
//   - flattens the ES module graph into one module script.
//
// By default it emits fragment HTML (no <html>/<head>/<body>) suitable for
// publishing as an artifact. `--standalone` wraps it in a full document.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

const read = (path) => readFile(join(PUBLIC, path), 'utf8');

// ------------------------------------------------------------ module graph

const IMPORT_RE = /^import\b[^;]*;/gm;
const EXPORT_LIST_RE = /^export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]+['"])?\s*;?/gm;
const EXPORT_PREFIX_RE = /^export\s+(?=(?:const|let|var|function|class|async)\b)/gm;
const DECLARATION_RE = /^(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

/** Relative specifiers imported by a module, in source order. */
function importsOf(source) {
  const specifiers = [];
  for (const statement of source.match(IMPORT_RE) ?? []) {
    const match = /from\s*['"]([^'"]+)['"]/.exec(statement);
    if (match?.[1].startsWith('.')) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Depth-first post-order walk, so dependencies land before their dependents. */
async function collectModules(entry) {
  const ordered = [];
  const seen = new Set();

  const visit = async (path) => {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    const source = await readFile(key, 'utf8');
    for (const specifier of importsOf(source)) {
      await visit(resolve(dirname(key), specifier));
    }
    ordered.push({ path: key, source });
  };

  await visit(entry);
  return ordered;
}

/** Strip module syntax so the file can be concatenated into one scope. */
function flatten(source) {
  return source.replace(IMPORT_RE, '').replace(EXPORT_LIST_RE, '').replace(EXPORT_PREFIX_RE, '');
}

/**
 * Concatenating modules only works while no two declare the same top-level
 * name, so check rather than emit something subtly broken.
 */
function assertNoCollisions(modules) {
  const owners = new Map();
  const clashes = [];
  for (const { path, code } of modules) {
    for (const match of code.matchAll(DECLARATION_RE)) {
      const name = match[1];
      if (owners.has(name)) clashes.push(`${name} (${owners.get(name)} and ${relative(PUBLIC, path)})`);
      else owners.set(name, relative(PUBLIC, path));
    }
  }
  if (clashes.length) {
    throw new Error(`cannot flatten: duplicate top-level names —\n  ${clashes.join('\n  ')}`);
  }
}

// ------------------------------------------------------------------ build

const outFile = process.argv[2] ?? join(ROOT, 'dist/torrent-audio.html');
const standalone = process.argv.includes('--standalone');

const [html, css, core, controller, processor] = await Promise.all([
  read('index.html'),
  read('styles.css'),
  read('lib/wsola-core.js'),
  read('lib/stretch-controller.js'),
  read('worklets/stretch-processor.js'),
]);

const modules = (await collectModules(join(PUBLIC, 'app.js'))).map((module) => ({
  ...module,
  code: flatten(module.source),
}));
assertNoCollisions(modules);

const moduleCode = modules
  .map(({ path, code }) => `// ---- ${relative(PUBLIC, path)} ${'-'.repeat(Math.max(0, 60 - relative(PUBLIC, path).length))}\n${code.trim()}`)
  .join('\n\n');

// The worklet module is still built from a blob at runtime, but its source now
// travels with the page instead of being fetched.
const workletSource = `${core}\n\n${controller}\n\n${processor}`;
const embedded = JSON.stringify(workletSource).replace(/<\//g, '<\\/');

// Pull the visible markup out of index.html and drop the parts a single file
// (or an artifact wrapper) supplies for itself.
const bodyMatch = /<body>([\s\S]*)<\/body>/.exec(html);
if (!bodyMatch) throw new Error('could not find <body> in index.html');
const body = bodyMatch[1]
  .replace(/<script\b[\s\S]*?<\/script>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .trim();

const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim() ?? 'Torrent Audio';

const parts = [
  `<title>${title}</title>`,
  `<style>\n${css.trim()}\n</style>`,
  body,
  `<script>\n${core.trim()}\n</script>`,
  `<script>\n${controller.trim()}\n</script>`,
  `<script>\nglobalThis.__STRETCH_MODULE_SOURCE__ = ${embedded};\n</script>`,
  `<script type="module">\n${moduleCode}\n</script>`,
];

let output = parts.join('\n\n');
if (standalone) {
  output = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n${output}\n</head>\n<body>\n</body>\n</html>`;
  // In standalone mode the markup has to live inside <body>, not <head>.
  output = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${title}</title>\n<style>\n${css.trim()}\n</style>\n</head>\n<body>\n${body}\n<script>\n${core.trim()}\n</script>\n<script>\n${controller.trim()}\n</script>\n<script>\nglobalThis.__STRETCH_MODULE_SOURCE__ = ${embedded};\n</script>\n<script type="module">\n${moduleCode}\n</script>\n</body>\n</html>`;
}

await writeFile(outFile, `${output}\n`);

const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`;
console.log(`Wrote ${outFile} (${kb(output)}${standalone ? ', standalone' : ', fragment'})`);
console.log(`  ${modules.length} modules flattened, worklet source embedded (${kb(workletSource)})`);
