import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// @pit/shared ships TypeScript source, so it must be bundled rather than required at runtime.
const bundleShared = { externalizeDeps: { exclude: ['@pit/shared'] } };

export default defineConfig({
  main: { build: bundleShared },
  preload: { build: bundleShared },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
