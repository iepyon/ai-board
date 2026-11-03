import { describe, expect, it } from 'vitest';
import { REVIEW_GATE_LABELS, reviewTone } from '../review-labels.js';

describe('REVIEW_GATE_LABELS', () => {
  it('ゲートを日本語の名前にする', () => {
    expect(REVIEW_GATE_LABELS.plan).toBe('計画');
  });
});

describe('reviewTone', () => {
  it('人の判断は結果ごとに分ける', () => {
    expect(reviewTone('承認')).toBe('approve');
    expect(reviewTone('否決')).toBe('reject');
    expect(reviewTone('中止')).toBe('abort');
  });

  it('提出と再提出は同じ色にし、保留は分ける', () => {
    expect(reviewTone('提出')).toBe('submit');
    expect(reviewTone('再提出')).toBe('submit');
    expect(reviewTone('保留')).toBe('hold');
  });
});
