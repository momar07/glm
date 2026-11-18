import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone web build of the renderer (PWA / Capacitor WebView).
// Mirrors the electron-vite renderer aliases; no Electron imports allowed.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
  },
  plugins: [react()],
  server: { fs: { allow: [resolve(__dirname)] } },
});
