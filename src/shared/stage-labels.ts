import type { Stage } from './schemas/common.js';

/** 列見出しに出す日本語ラベル。`ai-board status` と `decide` が使う */
export const STAGE_LABELS: Record<Stage, string> = {
  idea: 'アイデア',
  planning: '計画提案中',
  'plan-review': '計画レビュー',
  impling: '実装中',
  pr: 'PR中',
  merged: 'マージ済み',
};
