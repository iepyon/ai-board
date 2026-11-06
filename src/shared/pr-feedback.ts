// ============================================================
// PR の指摘に AI が応える番 — サーバと web の両方から使う純関数
// ============================================================

/** 判定に要る PR の状態だけ。サーバの `MrState` が満たす */
export interface PrFeedbackInput {
  readonly state: 'opened' | 'closed' | 'locked' | 'merged';
  readonly draft: boolean;
  /** 人が書いた最新のコメント（bot と AI のコメントを除く） */
  readonly latestNoteAt: string | null;
  readonly latestCommitAt: string | null;
  /** AI が人のアカウントで書いた最新のコメント（Claude Code のフッター付き） */
  readonly latestAiNoteAt: string | null;
}

/**
 * PR中 のカードで、人の指摘に AI が応える番か。
 *
 * PR が Ready で開いていて、人の最新のコメントが、ブランチの最新コミットとも AI の最新のコメントとも後にあるとき真。
 * AI は修正を push するか、直すものが無い理由を返信して応える。どちらかで時刻が逆転し、人の番に戻る。
 *
 * 質問や承認のコメントも指摘として扱う（GitHub の review の state は、自分の PR に Request changes を付けられず使えない）。
 * 直すものが無ければ AI が返信で戻すので、同じカードで AI の番が続くことは無い。
 * ステージは変えない（PR中 のまま）。ボードの区画と、ループの次の一手だけがこれを読む。
 */
export function awaitsPrFix(mr: PrFeedbackInput): boolean {
  if (mr.state !== 'opened' || mr.draft || mr.latestNoteAt === null) return false;

  const noteMs = Date.parse(mr.latestNoteAt);
  if (Number.isNaN(noteMs)) return false;

  return [mr.latestCommitAt, mr.latestAiNoteAt].every((at) => {
    if (at === null) return true;
    const ms = Date.parse(at);
    return Number.isNaN(ms) || noteMs > ms;
  });
}
