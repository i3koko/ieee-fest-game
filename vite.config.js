import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Each game is its own standalone page; index.html forwards to Wave Rider.
// Relative base so the build works under GitHub Pages' /<repo>/ path.
export default defineConfig({
  base: './',
  build: {
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        deadzone: resolve(import.meta.dirname, 'deadzone.html'),
        packetracer: resolve(import.meta.dirname, 'packetracer.html'),
        waverider: resolve(import.meta.dirname, 'waverider.html'),
      },
    },
  },
});
