import { startServer } from './server.js';

// 開発用エントリ（`npm run dev`）。カレントディレクトリを対象にする。
const server = await startServer({
  root: process.cwd(),
  ...(process.env['PORT'] !== undefined ? { port: Number(process.env['PORT']) } : {}),
});

console.warn(`ai-board running on ${server.url}`);
