import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
  },
  server: {
    port: 5674,
    proxy: {
      '/api': 'http://127.0.0.1:5673',
    },
  },
});
