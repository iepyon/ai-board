import type { Stage } from './schemas/common.js';

/** 列見出しに出す日本語ラベル。画面と `ai-board status` で共有する */
export const STAGE_LABELS: Record<Stage, string> = {
  idea: 'アイデア',
  planning: '計画提案中',
  'plan-review': '計画レビュー',
  impling: '実装中',
  verifying: '動作確認',
  pr: 'PR中',
  merged: 'マージ済み',
};
