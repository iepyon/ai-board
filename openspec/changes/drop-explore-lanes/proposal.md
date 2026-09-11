## Why

9 列のうち `exploring`（探索中）と `explore-review`（探索レビュー）は、実運用で列として機能していない。
探索は計画提案と一体で進み、explore ゲートの承認は `planning` へ進むためだけの通過儀礼になっている。
人が見るべき判断点は計画レビューと PR の 2 つで足り、列とゲートを 1 組減らすことで
ボードの意味も導出ルールも小さくなる。

## What Changes

- **BREAKING** ステージを 9 段から 7 段へ減らす。`exploring` と `explore-review` を削除する。
  - `idea` → `planning` → `plan-review` → `impling` → `verifying` → `pr` → `merged`
- **BREAKING** `startedAt` の打刻が立てるステージを `exploring` から `planning` へ変える。
  人がドラッグできる 1 遷移は `アイデア ⇄ 計画提案中` になる。
- **BREAKING** explore ゲートを廃止する。レビューゲートは `plan` の 1 つだけになる。
  - `## 探索メモ` 見出しはステージ導出の入力ではなくなる（本文の自由記述としては残る）。
  - `skipGates` に `explore` を宣言できなくなる。
  - `POST /api/cards/:id/reviews` は `gate: "explore"` を受け付けなくなる。
- 既存カードに残る `### <時刻> explore <種別>` の行は、未知のゲートとして黙って無視される。
  データ移行は行わない。

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

- `board-stages`: ステージの段数・`startedAt` が立てるステージ・ドラッグ可能な遷移が変わり、
  探索レビューの導出ルールが無くなる。
- `card-review`: ゲートの集合が `explore` / `plan` の 2 つから `plan` の 1 つへ減り、
  探索メモを成果物として扱う要件が無くなる。

## Impact

- `src/shared/schemas/common.ts` — `STAGES` から 2 段を削除
- `src/cards/models/review.ts` — `REVIEW_GATES` を `['plan']` へ
- `src/board/services/stage-resolver.ts` — `RULES` から 2 本を削除し、`planning` の条件を
  「explore 承認済み」から「`startedAt` が非 null」へ差し替える。`HUMAN_STAGES` を
  `['idea', 'planning']` へ
- `src/cards/services/review-log.ts` — `hasExploreNote` / 探索メモ見出しの定数を削除
- `src/web/types.ts` / `Board.tsx` / `detail/BodyEditor.tsx` — 列のラベル・所有者・色・
  ドロップ時のパッチ
- テスト: `stage-resolver.test.ts` / `board.e2e.test.ts`
- ドキュメント: `README.md` / `CLAUDE.md` の列の表
- `.ai-board/cards/board-loop-skill.md` のハードルール（探索レビューへの言及）
- API 互換: `GET /api/board` が返す `stage` / `floorStage` / `droppableStages` と
  `gates` のキー集合が変わる。ローカル専用ツールのため外部の利用者は無い。
- `openspec/specs/` はまだ空で、`board-stages` / `card-review` は `board-lanes` の
  delta spec としてのみ存在する。本 change の delta も同じ capability path に置く。
