// MOBIUS build script: three Vite builds into dist/.
//  1. background service worker (classic IIFE -> background.js)
//  2. content script (classic IIFE -> content.js; MV3 content scripts are not modules)
//  3. side-panel app (src/ui/index.html)
// Run via `npm run build` (after `tsc --noEmit`).
import { build } from 'vite';

const common = {
  minify: false,
  sourcemap: false,
  outDir: 'dist',
};

await build({
  configFile: false,
  publicDir: 'public',
  build: {
    ...common,
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/background/service-worker.ts',
      output: { format: 'iife', entryFileNames: 'background.js', inlineDynamicImports: true },
    },
  },
});

await build({
  configFile: false,
  publicDir: false,
  build: {
    ...common,
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/content/index.ts',
      output: { format: 'iife', entryFileNames: 'content.js', inlineDynamicImports: true },
    },
  },
});

await build({
  configFile: 'vite.config.ts',
});

console.log('[MOBIUS] build complete -> dist/');
