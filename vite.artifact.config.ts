/**
 * Build config for the single-file published preview.
 *
 * Differences from the app build: one HTML entry under artifact/, every chunk
 * inlined into a single JS bundle (there is nothing to lazy-load here — the
 * OCR and PDF paths aren't part of this build), and assets inlined rather than
 * emitted, because the published page must be self-contained.
 *
 * `npm run build:artifact` runs this and then folds the CSS and JS into one
 * HTML fragment. See scripts/build-artifact.mjs.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-artifact',
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: 'artifact/index.html',
      output: { inlineDynamicImports: true },
    },
  },
});
