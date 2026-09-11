詳細な手順・テストコード・差分は `docs/superpowers/plans/2026-09-11-board-lanes.md` にある。
ここは進捗の追跡単位として、その 9 タスクを検証方法つきで並べたもの。

## 1. レビューログ

- [x] 1.1 `src/cards/models/review.ts` に `ReviewGate` / `ReviewKind` / `ReviewEntry` / `GateState` を定義し、`npm run typecheck` が通ることを確認する
- [x] 1.2 `src/cards/services/review-log.ts` に `parseReviewLog` / `gateState` / `isAborted` / `hasExploreNote` を実装し、`npx vitest run src/cards/services/__tests__/review-log.test.ts` が通ることを確認する（書式の壊れた見出しを無視するケース、他ゲートが混ざらないケース、`skipGates` で通過扱いになるケースを含む）
- [x] 1.3 `appendReviewEntry` を実装し、追記した結果を `parseReviewLog` が読み戻せることをテストで確認する（レビュー見出しが無い本文、既存セクションへの追記、後ろに別セクションがある場合の 3 経路）

## 2. カードスキーマ

- [ ] 2.1 `Card` から `explored` / `implStartedAt` / `stageOverride` を外し `startedAt` / `skipGates` を足す。`CardFrontmatterSchema` と `UpdateCardMetaInputSchema` を追従させ、`AppendReviewInputSchema`（否決に理由文を必須とする refine 付き）を足す
- [ ] 2.2 `fs-card.repository.ts` と `create-card.command.ts` を追従させ、`npx vitest run src/cards/` が通ることを確認する。`skipGates` の往復と、`skipGates` を持たない既存ファイルが空配列として読めることをテストで確認する

## 3. ステージ導出

- [ ] 3.1 `src/shared/schemas/common.ts` の `STAGES` を 9 段へ入れ替える
- [ ] 3.2 `stage-resolver.ts` の `RULES` を差し替え、`HUMAN_STAGES` を `['idea','exploring']` へ縮め、`hasFixAfterReview` を export する。`npx vitest run src/board/services/` が通ることを確認する（9 段すべての導出、否決による差し戻し 2 経路、tasks 0 件を全完了扱いしないこと、`droppableStages` が下限で空になることを含む）

## 4. ボード読み取り

- [ ] 4.1 `BoardCard` から `derivedStage` / `overridden` / `diverged` / `stageOverride` / `explored` / `implStartedAt` を外し、`aborted` / `gates` / `startedAt` / `skipGates` を足す。`BoardCardMr` に `resubmitted` を足す
- [ ] 4.2 `get-board.query.ts` を追従させ、`npm run typecheck`（サーバ側）と `npx vitest run` が通ることを確認する。e2e でレビューログから導出したステージが返ること、削除したフィールドがレスポンスに現れないことを確認する

## 5. レビュー API

- [ ] 5.1 `append-review.command.ts` を実装し、composition root に登録する。`npx vitest run -t appendReviewCommand` が通ることを確認する
- [ ] 5.2 `POST /api/cards/:id/reviews` を足し、e2e で確認する（承認で `planning` へ進む / 理由なし否決が 400 / 理由付き否決で `exploring` へ戻り本文に理由が残る / 中止で `aborted` になる / 存在しないカードが 404）

## 6. ボード UI

- [ ] 6.1 `src/web/types.ts` の `Stage` / `STAGE_LABELS` / `STAGE_OWNER` / `STAGE_SOURCE` / `GATE_OF_STAGE` / `BoardCard` を差し替え、`api.ts` に `appendReview` を足す
- [ ] 6.2 `Board.tsx` の `patchForStage` を `idea ⇄ exploring` の 1 遷移へ縮め、`stageOverride` の解除処理を消す。`Column.tsx` の列見出しを `STAGE_OWNER` ベースにする
- [ ] 6.3 `ReviewActions.tsx` を新設して `ProgressActions.tsx` を削除し、`CardDetail.tsx` / `StageSection.tsx` / `CardBadges.tsx` / `App.tsx`（中止カードの折り畳み）を追従させる。`npm run typecheck && npm run lint && npm test` が全部通ることを確認する
- [ ] 6.4 `npm run dev` と `npm run dev:web` を立てて目視で確認する。9 列が並ぶこと / アイデア ⇄ 探索中 のドラッグが往復できること / 探索メモを書くと探索レビューへ移り掴めなくなること / 否決すると探索中へ戻り理由が本文に残ること / 中止するとカードが畳まれトグルで戻せること

## 7. 移行とドキュメント

- [ ] 7.1 `.ai-board/cards/*.md` 16 枚の frontmatter を移行し、`grep -l 'explored\|implStartedAt\|stageOverride' .ai-board/cards/*.md` が何も返さないことを確認する
- [ ] 7.2 `.ai-board/cards/board-loop-skill.md` のハードルールを書き換える（`startedAt` を自分で打たない / `## レビュー` に書いてよいのは提出と再提出だけ / `skipGates` を自分で足さない）
- [ ] 7.3 `CLAUDE.md` と `README.md` のステージ導出の節・書き込み境界の表・API の表を 9 列に合わせて書き換え、`npm run typecheck && npm run lint && npm test` が通ることを確認する
