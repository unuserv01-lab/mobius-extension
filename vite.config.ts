// Vite config for the Side Panel app (the only bundle `vite build` produces
// on its own). The background service worker and content script are built
// by scripts/build.mjs, which calls Vite's build API three times — Vite's
// defineConfig does not accept an array of configs, and MV3 content scripts
// must be classic IIFE scripts, not ES modules.
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/ui/index.html',
    },
    minify: false,
    sourcemap: false,
  },
});
