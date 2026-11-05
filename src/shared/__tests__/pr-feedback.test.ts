import { describe, expect, it } from 'vitest';
import { awaitsPrFix, type PrFeedbackInput } from '../pr-feedback.js';

const base: PrFeedbackInput = {
  state: 'opened',
  draft: false,
  latestNoteAt: '2026-11-04T10:00:00Z',
  latestCommitAt: '2026-11-04T09:00:00Z',
  latestAiNoteAt: null,
};

describe('awaitsPrFix', () => {
  it('人の指摘が最新コミットより後なら AI の番', () => {
    expect(awaitsPrFix(base)).toBe(true);
  });

  it('指摘の後に修正が push されていれば人の番（再レビュー待ち）', () => {
    expect(awaitsPrFix({ ...base, latestCommitAt: '2026-11-04T11:00:00Z' })).toBe(false);
  });

  it('指摘の後に AI が返信していれば人の番', () => {
    expect(awaitsPrFix({ ...base, latestAiNoteAt: '2026-11-04T11:00:00Z' })).toBe(false);
  });

  it('AI の返信の後に人がまた指摘すれば AI の番', () => {
    expect(
      awaitsPrFix({
        ...base,
        latestAiNoteAt: '2026-11-04T09:30:00Z',
        latestNoteAt: '2026-11-04T10:00:00Z',
      })
    ).toBe(true);
  });

  it('人のコメントが無ければ AI の番ではない', () => {
    expect(awaitsPrFix({ ...base, latestNoteAt: null })).toBe(false);
  });

  it('コミットの時刻が取れなくても、指摘があれば AI の番', () => {
    expect(awaitsPrFix({ ...base, latestCommitAt: null })).toBe(true);
  });

  it('Draft・マージ済み・閉じた PR では AI の番にしない', () => {
    expect(awaitsPrFix({ ...base, draft: true })).toBe(false);
    expect(awaitsPrFix({ ...base, state: 'merged' })).toBe(false);
    expect(awaitsPrFix({ ...base, state: 'closed' })).toBe(false);
  });

  it('指摘の時刻が読めなければ AI の番にしない', () => {
    expect(awaitsPrFix({ ...base, latestNoteAt: 'not-a-date' })).toBe(false);
  });
});
