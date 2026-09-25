import type { ErrorResponse } from '../../shared/controllers/error-response.js';
import type { GetBoardError, GetPlanError } from '../errors/board-errors.js';

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

export function mapGetPlanErrorToResponse(error: GetPlanError): ErrorResponse {
  switch (error.type) {
    case 'PlanNotFound':
      return {
        status: 404,
        response: {
          code: 'PLAN_NOT_FOUND',
          message: `計画が見つかりません: ${error.id}`,
        },
      };
    case 'PlanUnreadable':
      return {
        status: 500,
        response: {
          code: 'PLAN_UNREADABLE',
          message: `計画を読み込めませんでした: ${error.reason}`,
        },
      };
  }
}
