import type { ErrorResponse } from '../../shared/controllers/error-response.js';
import type { CreateCardError, MoveCardError, UpdateCardError } from '../errors/card-errors.js';

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
  }
}

export function mapMoveCardErrorToResponse(error: MoveCardError): ErrorResponse {
  switch (error.type) {
    case 'CardNotFound':
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
