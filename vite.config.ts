import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { buildVersion } from './build-version.ts';

export default defineConfig(({ command }) => {
  const version = command === 'build' ? buildVersion(fileURLToPath(new URL('.', import.meta.url))) : undefined;
  return {
    base: './',
    server: { port: 4381, strictPort: true },
    preview: { port: 4381, strictPort: true },
    build: { outDir: 'docs', chunkSizeWarningLimit: 1600 },
    define: { 'import.meta.env.VITE_BUILD_DATE': JSON.stringify(version?.builtAt ?? '') },
    plugins: version ? [{
      name: 'date-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: `${JSON.stringify(version, null, 2)}\n`,
        });
      },
    }] : [],
  };
});
