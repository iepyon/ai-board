import { startServer } from './server.js';

// 開発用エントリ（`npm run dev`）。カレントディレクトリを対象にする。
const server = await startServer({
  root: process.cwd(),
  ...(process.env['PORT'] !== undefined ? { port: Number(process.env['PORT']) } : {}),
});

console.warn(`ai-board running on ${server.url}`);

// 止まるときに close() を通し、server.json を死んだ pid のまま残さない
const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
