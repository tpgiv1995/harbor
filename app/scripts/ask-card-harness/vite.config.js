import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the answer-sheet visual harness to scripts/ask-card-harness/dist.
// From app/:
//   node scripts/ask-card-harness/make-menus.js
//   npx vite build --config scripts/ask-card-harness/vite.config.js
// then open dist/index.html in a browser (or screenshot it with Playwright).
// JSX compiles through Vite's own esbuild pass, the same as the app.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
});
