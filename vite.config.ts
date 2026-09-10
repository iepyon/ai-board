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
      // 前方一致にすると `/api.ts`（web 側の api.ts モジュール）まで
      // サーバへ流れてしまう。`^` 始まりのキーは正規表現として扱われるので、
      // パス区切りまで含めて一致させる。
      '^/api(?:/|$)': 'http://127.0.0.1:5673',
    },
  },
});
