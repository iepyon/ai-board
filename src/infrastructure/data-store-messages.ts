import { dataModePath } from './config.js';
import type { DataStoreError } from './data-store.js';

// ============================================================
// データ用ブランチの読み書きの失敗を、人が次に何をすればよいかの文にする
// ============================================================

/**
 * `DataStoreError` を CLI の 1 行にする。
 *
 * データ用ブランチが無いときは、空のデータ用ブランチを作る `ai-board init` を案内する。
 */
export function describeDataStoreError(error: DataStoreError): string {
  switch (error.type) {
    case 'DataBranchMissing':
      return (
        `データ用ブランチ（origin の ai-board/data）がありません（${error.dataDir}）。` +
        'ai-board init を走らせてください'
      );
    case 'DataDirNotRepository':
      return `${error.dataDir} は git のワークツリーではありません。中身を確かめ、要らなければ消してからやり直してください`;
    case 'DataDirWrongBranch':
      return (
        `${error.dataDir} は ai-board/data ではないブランチ（${error.branch ?? 'detached HEAD'}）を checkout しているため、何も変えずに止まりました。` +
        'AI_BOARD_DATA には、データ用ブランチ（ai-board/data）を checkout した clone を指してください'
      );
    case 'DataStoreLockTimeout':
      return `ほかの ai-board がデータ用ブランチを使っています（${error.lockPath}）。しばらくしてからやり直してください`;
    case 'DataStoreFetchFailed':
      return `データ用ブランチを取り直せないため、書き込めません（${error.message}）`;
    case 'DataStorePushFailed':
      return `データ用ブランチへ push できませんでした（${error.attempts} 回試しました: ${error.message}）`;
    case 'DataStoreLocalAhead': {
      const dataDir = error.dataDir;
      const modeFile = dataModePath(dataDir);
      return (
        `データのワークツリー（${dataDir}）に、origin の ai-board/data に無い commit が ${error.count} 件あるため、読み書きを止めました。` +
        `手元モードで書いたものなら、上げるには git -C ${dataDir} push origin HEAD:ai-board/data、` +
        `捨てるには git -C ${dataDir} reset --hard origin/ai-board/data を人が走らせてください。` +
        `手元モードで続けるなら ${modeFile} に mode: local と書いてください`
      );
    }
    case 'DataStoreGitFailed':
      return `データ用ブランチの git ${error.step} に失敗しました（${error.message}）`;
    case 'UnsupportedDataVersion':
      return (
        `データ用ブランチの形の版（${error.found}）が、この ai-board が読める版（${error.supported}）より新しいため、読まずに止まりました。` +
        'ai-board を新しくしてからやり直してください'
      );
    case 'MalformedDataVersion':
      return `データ用ブランチの ai-board-data.yaml が読めないため、読まずに止まりました（${error.reason}）`;
  }
}

/** 読み出しの前の取り直しで fetch に失敗したときの警告。手元の内容で読み続ける */
export function describeOfflineRead(reason: string): string {
  return `データ用ブランチを取り直せないため、手元の内容で読みます（${reason}）`;
}
