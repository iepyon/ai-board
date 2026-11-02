import { spawnDetached, type DetachedSpawn } from './cli-runner.js';

// ============================================================
// 既定のブラウザで URL を開く
// ============================================================

/** ブラウザを開くコマンドと、引数の配列 */
export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * OS ごとに、既定のブラウザで `url` を開くコマンドを返す。
 *
 * Windows の `start` は cmd の組み込みで、`spawn` すると ENOENT になる。
 * `cmd /c start "" <url>` は cmd の引数の解釈を通り、URL に `&` などが入ると壊れるので、
 * shell を介さずに開ける `rundll32 url.dll,FileProtocolHandler <url>` を使う。
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

/**
 * 既定のブラウザで `url` を開く。開けなくても例外を投げず、警告を 1 行出して続ける。
 *
 * 起動は `cli-runner.ts` の `spawnDetached` に任せる（外部コマンドは cli-runner に閉じ、shell を介さない）。
 * コマンドが無いときの失敗は子プロセスの `error` イベントで後から届くが、`spawnDetached` がリスナーを付けて
 * `onError` に渡すので、サーバは落ちない。URL は起動ログに出ているので、開けなくても人は自分で開ける。
 */
export function openBrowser(
  url: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly spawn?: DetachedSpawn;
    readonly warn?: (message: string) => void;
  } = {}
): void {
  const { command, args } = browserCommand(options.platform ?? process.platform, url);
  const warn = options.warn ?? ((message: string) => console.warn(message));

  (options.spawn ?? spawnDetached)(command, args, (error) => {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`[ai-board] ブラウザを開けませんでした（${command}: ${reason}）。${url} を開いてください`);
  });
}
