import { defineConfig } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function copyExcalidrawAssets() {
  return {
    name: 'copy-excalidraw-assets',
    buildStart() {
      const source = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');
      const target = resolve('public/excalidraw-assets/fonts');
      if (existsSync(source)) cpSync(source, target, { recursive: true });
    },
  };
}

// base './' is required: Electron loads dist/index.html over file://,
// where Vite's default absolute asset paths resolve to the filesystem root.
//
// export.html is the board-export page: a self-contained bundle of Excalidraw's
// exportToBlob (src/board-export/entry.js) that board-export-runner.cjs loads
// into a hidden BrowserWindow. It rides the SAME build so the bundle exists
// whenever the app is built; dist/excalidraw-assets serves both pages' fonts.
export default defineConfig({
  base: './',
  plugins: [copyExcalidrawAssets()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        boardExport: resolve('export.html'),
      },
    },
  },
});
