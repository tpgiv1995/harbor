import { defineConfig } from 'vite';

// base './' is required: Electron loads dist/index.html over file://,
// where Vite's default absolute asset paths resolve to the filesystem root.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
});
