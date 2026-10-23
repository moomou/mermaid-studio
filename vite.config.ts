import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 4381, strictPort: true },
  preview: { port: 4381, strictPort: true },
  build: { outDir: 'docs', chunkSizeWarningLimit: 1600 },
});
