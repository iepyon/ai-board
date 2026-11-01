import type { ErrorResponse } from '../../shared/controllers/error-response.js';
import type {
  CardWriteFailure,
  CreateCardError,
  MoveCardError,
  UpdateCardError,
} from '../errors/card-errors.js';

// ============================================================
// カードエラー → HTTP レスポンス マッピング
// ============================================================

export function mapCreateCardErrorToResponse(error: CreateCardError): ErrorResponse {
  switch (error.type) {
    case 'DuplicateCardId':
      return {
        status: 409,
        response: {
          code: 'DUPLICATE_CARD_ID',
          message: `この ID のカードは既に存在します: ${error.id}`,
        },
      };
    case 'InvalidCardId':
      return {
        status: 400,
        response: { code: 'INVALID_CARD_ID', message: error.reason },
      };
    case 'CardWriteRefused':
    case 'DataBranchMissing':
    case 'DataDirNotRepository':
    case 'DataStoreLockTimeout':
    case 'DataStoreFetchFailed':
    case 'DataStorePushFailed':
    case 'DataStoreGitFailed':
    case 'UnsupportedDataVersion':
    case 'MalformedDataVersion':
      return mapCardWriteFailureToResponse(error);
  }
}

export function mapUpdateCardErrorToResponse(error: UpdateCardError): ErrorResponse {
  switch (error.type) {
    case 'CardNotFound':
      return {
        status: 404,
        response: {
          code: 'CARD_NOT_FOUND',
          message: `カードが見つかりません: ${error.id}`,
        },
      };
    case 'CardWriteRefused':
    case 'DataBranchMissing':
    case 'DataDirNotRepository':
    case 'DataStoreLockTimeout':
    case 'DataStoreFetchFailed':
    case 'DataStorePushFailed':
    case 'DataStoreGitFailed':
    case 'UnsupportedDataVersion':
    case 'MalformedDataVersion':
      return mapCardWriteFailureToResponse(error);
  }
}

export function mapMoveCardErrorToResponse(error: MoveCardError): ErrorResponse {
  switch (error.type) {
    case 'CardNotFound':
    case 'CardWriteRefused':
    case 'DataBranchMissing':
    case 'DataDirNotRepository':
    case 'DataStoreLockTimeout':
    case 'DataStoreFetchFailed':
    case 'DataStorePushFailed':
    case 'DataStoreGitFailed':
    case 'UnsupportedDataVersion':
    case 'MalformedDataVersion':
      return mapUpdateCardErrorToResponse(error);
    case 'StaleOrder':
      return {
        status: 409,
        response: {
          code: 'STALE_ORDER',
          message: `並び順が変わっています（${error.after} が ${error.before} より後ろにあります）。ボードを読み直してください`,
        },
      };
  }
}

/**
 * 書き込みの 1 操作（`DataStore.transact`）の失敗。
 *
 * push・fetch の失敗とロック待ちは、ネットワークやほかの書き込みの都合で、時間を置けば通りうるので 503 にする。
 * データ用ブランチが無い・ワークツリーが壊れている・git の操作が失敗した・形の版がこの ai-board より新しいか読めない、
 * は置き場所の不備なので 500 にする。
 * 理由の文は `DataStoreError` の時点で終了コードまでにとどめてあり、git の stderr（資格情報が混じりうる）は含まない。
 */
export function mapCardWriteFailureToResponse(error: CardWriteFailure): ErrorResponse {
  switch (error.type) {
    case 'CardWriteRefused':
      return {
        status: 409,
        response: {
          code: 'CARD_WRITE_REFUSED',
          message: `カードのファイルへの書き込みを拒みました（${error.reason}）。判断のエントリは書き換えられず、着手の時刻は最新の着手・着手を戻すより後にしか置けません`,
        },
      };
    case 'DataStorePushFailed':
      return {
        status: 503,
        response: {
          code: 'DATA_STORE_PUSH_FAILED',
          message: `データ用ブランチへ push できませんでした（${error.attempts} 回試しました: ${error.message}）。時間を置いてやり直してください`,
        },
      };
    case 'DataStoreFetchFailed':
      return {
        status: 503,
        response: {
          code: 'DATA_STORE_FETCH_FAILED',
          message: `データ用ブランチを取り直せないため、書き込めません（${error.message}）。ネットワークを確かめてやり直してください`,
        },
      };
    case 'DataStoreLockTimeout':
      return {
        status: 503,
        response: {
          code: 'DATA_STORE_BUSY',
          message:
            'ほかの ai-board がデータ用ブランチに書き込んでいます。しばらくしてからやり直してください',
        },
      };
    case 'DataBranchMissing':
      return {
        status: 500,
        response: {
          code: 'DATA_BRANCH_MISSING',
          message: `データ用ブランチ（origin の ai-board/data）がありません（${error.dataDir}）。ai-board migrate を走らせてください`,
        },
      };
    case 'DataDirNotRepository':
      return {
        status: 500,
        response: {
          code: 'DATA_DIR_NOT_REPOSITORY',
          message: `${error.dataDir} は git のワークツリーではありません`,
        },
      };
    case 'DataStoreGitFailed':
      return {
        status: 500,
        response: {
          code: 'DATA_STORE_GIT_FAILED',
          message: `データ用ブランチの git ${error.step} に失敗しました（${error.message}）`,
        },
      };
    case 'UnsupportedDataVersion':
      return {
        status: 500,
        response: {
          code: 'UNSUPPORTED_DATA_VERSION',
          message: `データ用ブランチの形の版（${error.found}）が、この ai-board が読める版（${error.supported}）より新しいため、書き込みませんでした。ai-board を新しくしてください`,
        },
      };
    case 'MalformedDataVersion':
      return {
        status: 500,
        response: {
          code: 'MALFORMED_DATA_VERSION',
          message: `データ用ブランチの ai-board-data.yaml が読めないため、書き込みませんでした（${error.reason}）`,
        },
      };
  }
}
