## 1. 定義を減らす

- [x] 1.1 `src/shared/schemas/common.ts` の `STAGES` から `exploring` と `explore-review` を削り、
      docstring を 7 段へ書き換える。`npm run typecheck` が `Stage` を使う箇所で網羅性エラーを
      出すことを確認する（この時点では失敗が正しい）
- [x] 1.2 `src/cards/models/review.ts` の `REVIEW_GATES` を `['plan']` にし、`explore` を含まない
      ことを確認する

## 2. 導出ルールを差し替える

- [x] 2.1 `stage-resolver.ts` の `RULES` から `explore-review` と `exploring` の 2 本を削除し、
      `planning` の条件を `gates.explore === 'approved'` から `card.startedAt !== null` へ
      差し替える。判定表の docstring も 7 段へ直す
- [x] 2.2 `HUMAN_STAGES` を `['idea', 'planning']` にし、`Facts` から `exploreNote` を、
      `toFacts` から `explore` ゲートの評価を落とす
- [x] 2.3 `review-log.ts` から `hasExploreNote` と探索メモ見出しの定数を削除し、
      `npm run typecheck` で未使用の参照が残っていないことを確認する

## 3. サーバのテストを追従させる

- [x] 3.1 `stage-resolver.test.ts` の `exploring` / `explore-review` のケースを削り、
      「`startedAt` を打つと `planning`」「plan 否決で `planning` へ落ちる」
      「`## 探索メモ` があってもステージが動かない」を検証する
- [x] 3.2 `stage-resolver.test.ts` に `droppableStages` の回帰を足す。成果物が無いカードは
      `['idea', 'planning']`、proposal のあるカードは空配列になること
- [x] 3.3 `board.e2e.test.ts` の explore ゲート前提のケースを plan ゲートへ寄せ、
      `POST /api/cards/:id/reviews` に `gate: "explore"` を送ると 400 が返ることを検証する
- [x] 3.4 `npx vitest run src/board src/cards` が通ることを確認する

## 4. web を追従させる

- [x] 4.1 `src/web/types.ts` の `Stage` から 2 段を削り、`ReviewGate` を `'plan'` にする。
      `STAGE_LABELS` / `STAGE_OWNER` / `STAGE_SOURCE` の余ったキーを落とす
- [x] 4.2 `GATE_OF_STAGE` を `plan-review` だけにし、`HUMAN_STAGES` を
      `['idea', 'planning']` にする（`Partial<Record<...>>` なので型では検出されない）
- [x] 4.3 `Board.tsx` の `patchForStage` の `case 'exploring'` を `case 'planning'` へ変え、
      コメントの「9 列」を 7 列に直す
- [x] 4.4 `detail/BodyEditor.tsx` の placeholder から `## 探索メモ` を外す
- [x] 4.5 `npm run typecheck` が 2 つの tsconfig 両方で通ることを確認する

## 5. ドキュメントと運用ルール

- [x] 5.1 `README.md` の列の表とステージ導出の説明を 7 列・ゲート 1 つへ直す
- [x] 5.2 `CLAUDE.md` の冒頭の列図、列の所有権の表、ステージ導出節、ハードルールから
      探索中 / 探索レビュー / explore ゲートの記述を落とす
- [x] 5.3 `.ai-board/cards/board-loop-skill.md` のハードルールから探索レビューへの言及を落とす

## 6. 品質ゲート

- [x] 6.1 `npm run typecheck && npm run lint && npm test` をすべて通す
- [x] 6.2 `npm run dev` と `npm run dev:web` でボードを開き、7 列が並ぶこと・
      アイデアのカードを計画提案中へドラッグすると `startedAt` が打たれることを確認する
