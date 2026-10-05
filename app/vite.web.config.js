import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Mobile PWA client. Served over HTTPS via tailscale serve; WSS to the same host.
export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  base: '/',
  publicDir: resolve(import.meta.dirname, 'web/public'),
  build: {
    // NOT inside dist/: the desktop build writes to dist/ and vite empties it,
    // so every `npm run build` (and therefore every E2E gate run) deleted the
    // whole mobile client and the server started answering a bare 404.
    outDir: resolve(import.meta.dirname, 'dist-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'web/index.html'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/health': { target: 'http://127.0.0.1:8787' },
      '/icons': { target: 'http://127.0.0.1:8787' },
    },
  },
});
