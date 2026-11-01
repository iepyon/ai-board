import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

// ============================================================
// server.json — 起動中のサーバの場所を書き残す
// ============================================================

/**
 * サーバは 5673 が使用中だと次のポートへ繰り上がるので、ポートを決め打ちできない。
 * そこで起動したサーバが自分の場所をデータのワークツリーの親に書き、`ai-board status` がそれを読んで
 * チャットから人の API を叩く入口（`board-decide` のスキル）に URL を渡す。
 *
 * 置き場所をデータのワークツリーの親（既定なら `.ai-board/`、`AI_BOARD_DATA` ならそのディレクトリの隣）に
 * するのは、`AI_BOARD_DATA` で別のデータを指す開発用のサーバが、メインのサーバのファイルを
 * 上書きしたり消したりしないため。
 */
export const SERVER_INFO_FILE = 'server.json';

const ServerInfoSchema = z.object({
  url: z.string().min(1),
  pid: z.number().int().positive(),
  dataDir: z.string().min(1),
  startedAt: z.string().min(1),
});

export type ServerInfo = z.infer<typeof ServerInfoSchema>;

/** 生きているサーバの場所。`status --json` の `server` に出す */
export interface ServerLocation {
  readonly url: string;
}

/** データのワークツリーに対応する server.json の場所 */
export function serverInfoPath(dataDir: string): string {
  return path.join(path.dirname(path.resolve(dataDir)), SERVER_INFO_FILE);
}

/** 起動時に書く。書けなくてもサーバは動けるので、警告だけ出して続ける */
export function writeServerInfo(info: ServerInfo): void {
  try {
    fs.writeFileSync(serverInfoPath(info.dataDir), `${JSON.stringify(info, null, 2)}\n`, 'utf-8');
  } catch (error) {
    console.warn(`[ai-board] ${SERVER_INFO_FILE} を書けませんでした: ${String(error)}`);
  }
}

/**
 * 止まるときに消す。中の pid が自分のときだけ消す。
 * 後から起動した別のサーバが上書きしていれば、それはそのサーバのものだから。
 */
export function removeServerInfo(dataDir: string, pid: number): void {
  const file = serverInfoPath(dataDir);
  if (readServerInfo(file)?.pid !== pid) return;

  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    console.warn(`[ai-board] ${SERVER_INFO_FILE} を消せませんでした: ${String(error)}`);
  }
}

/**
 * `dataDir` のデータのワークツリーを使って生きているサーバを探す。無ければ null。
 *
 * ファイルが無い・形が違う・別のデータのもの・プロセスが死んでいる（落ちたサーバの残骸）の
 * どれでも null にする。
 */
export function findLiveServer(
  dataDir: string,
  isAlive: (pid: number) => boolean = isProcessAlive
): ServerLocation | null {
  const info = readServerInfo(serverInfoPath(dataDir));
  if (info === null) return null;
  if (path.resolve(info.dataDir) !== path.resolve(dataDir)) return null;
  if (!isAlive(info.pid)) return null;

  return { url: info.url };
}

function readServerInfo(file: string): ServerInfo | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = ServerInfoSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** シグナル 0 は届くかだけを確かめる。EPERM は別のユーザのプロセスが生きていることを示す */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
