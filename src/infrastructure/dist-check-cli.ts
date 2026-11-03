import * as fs from 'node:fs';
import * as path from 'node:path';
import { isErr } from '../shared/result.js';
import { describeCliError, type CliRunner } from './cli-runner.js';

// ============================================================
// ai-board dist-check — dist/ が HEAD のコミットより古いかを確かめる
// ============================================================

/**
 * ループ（`/board-loop`）と `board-decide` が、`status` を読む前に `dist/` を作り直すかを決めるのに使う。
 *
 * 以前は手順書が `node -e` で `dist/cli.js` の mtime と HEAD のコミット時刻を比べていたが、
 * `node -e` は任意のコードを走らせられるので許可ルールの `allow` に入れられず、毎周に確認が出ていた。
 * 比べ方は変えずに CLI へ移し、`node <path>/dist/cli.js dist-check` の形で許せるようにする。
 *
 * 終了コードは 0 が新しい、1 が古い（`dist/cli.js` が無いときも含む）、2 が確かめられなかった。
 * 手順書は `if ! ...; then npm run build; fi` と 0 以外をすべて「ビルドし直す」に倒す。
 * `dist-check` を持たない古い `dist/` は「不明なオプションです」で 1 を返すので、同じくビルドに倒れる。
 */
export const DIST_CHECK_USAGE = `使い方: ai-board dist-check [--root <path>]

<root>/dist/cli.js が、<root> の HEAD のコミットより古いかを確かめる（ビルドし直すかを決めるのに使う）。

終了コード:
  0  新しい（ビルドし直さなくてよい）
  1  古い、または dist/cli.js が無い
  2  確かめられなかった（引数の誤り、git の失敗）
`;

export const DIST_CHECK_FRESH = 0;
export const DIST_CHECK_STALE = 1;
export const DIST_CHECK_FAILED = 2;

export interface DistCheckIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface DistCheckDependencies {
  /** 対象のリポジトリの根（`--root`） */
  readonly root: string;
  /** git を呼ぶ。shell を介さない */
  readonly runner: CliRunner;
  /** ファイルの mtime（ミリ秒）。無ければ null */
  readonly mtimeMs: (file: string) => number | null;
}

/** `ai-board dist-check` を実行し、終了コードを返す */
export async function runDistCheckCli(
  argv: readonly string[],
  deps: DistCheckDependencies,
  io: DistCheckIo
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(DIST_CHECK_USAGE);
    return DIST_CHECK_FRESH;
  }
  if (argv.length > 0) {
    io.stderr(`不明な引数です: ${argv.join(' ')}\n\n${DIST_CHECK_USAGE}`);
    return DIST_CHECK_FAILED;
  }

  const distFile = path.join(deps.root, 'dist', 'cli.js');
  const mtimeMs = deps.mtimeMs(distFile);
  if (mtimeMs === null) {
    io.stdout(`${distFile} がありません。ビルドしてください\n`);
    return DIST_CHECK_STALE;
  }

  const log = await deps.runner.run('git', ['-C', deps.root, 'log', '-1', '--format=%ct']);
  if (isErr(log)) {
    io.stderr(`HEAD のコミット時刻を読めませんでした: ${describeCliError(log.error)}\n`);
    return DIST_CHECK_FAILED;
  }

  const commitTime = Number(log.value.trim());
  if (log.value.trim() === '' || !Number.isFinite(commitTime)) {
    io.stderr(`HEAD のコミット時刻を読めませんでした: ${JSON.stringify(log.value.trim())}\n`);
    return DIST_CHECK_FAILED;
  }

  // 秒の精度で比べる（コミット時刻は秒）。同じ秒は新しいとみなす
  if (mtimeMs / 1000 >= commitTime) {
    io.stdout(`${distFile} は HEAD のコミットより新しい\n`);
    return DIST_CHECK_FRESH;
  }

  io.stdout(`${distFile} は HEAD のコミットより古い。ビルドし直してください\n`);
  return DIST_CHECK_STALE;
}

/** 実際のファイルの mtime を読む。無ければ null */
export function readMtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
