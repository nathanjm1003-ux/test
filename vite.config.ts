import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `--host` by default so you can open the dev server from a phone on the
    // same Wi-Fi network (scanning happens on a phone).
    host: true,
  },
  // Same for `npm run preview` — that is the build that has the OCR engine
  // vendored into public/, so it is the one to test scanning against.
  preview: { host: true },
  worker: { format: 'es' },
  optimizeDeps: {
    // pdf.js ships ESM with a separate worker entry; let Vite prebundle it.
    include: ['pdfjs-dist'],
  },
});
