import type { ErrorResponse } from '../../shared/controllers/error-response.js';
import type { GetBoardError } from '../errors/board-errors.js';

// ============================================================
// ボードエラー → HTTP レスポンス マッピング
// ============================================================

export function mapGetBoardErrorToResponse(error: GetBoardError): ErrorResponse {
  switch (error.type) {
    case 'BoardUnreadable':
      return {
        status: 500,
        response: {
          code: 'BOARD_UNREADABLE',
          message: `ボードを読み込めませんでした: ${error.reason}`,
        },
      };
  }
}
