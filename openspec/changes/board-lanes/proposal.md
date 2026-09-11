## Why

現行の 7 列（`idea` / `explored` / `proposed` / `impling` / `ai-pr` / `ai-pr-fixed` / `done`）は、
「工程がどこまで進んだか」と「いま誰の番か」を 1 本の軸に畳んでいる。
`explored` は "探索が済んだ" と "人の承認待ち" を兼ね、`proposed` も `ai-pr` も同じ二重性を持つ。

ボードを `/loop` で回す前提に立つと、この二重性が運用上の問題になる。
人が朝ボードを開いたときに「自分が手を動かすべきカード」が一目で分からず、
AI 側も「どこで止まるべきか」を列から読み取れない。

さらに現状では、人が下した判断（承認した・否決した・その理由）がどこにも残らない。
`explored` フラグは「探索が済んだ」ことは言えても「人が見て良しとした」ことは言えず、
否決の理由に至っては記録する場所そのものが存在しない。

## What Changes

- **BREAKING** ステージを 7 段から 9 段へ入れ替える。
  `idea` / `exploring` / `explore-review` / `planning` / `plan-review` / `impling` / `verifying` / `pr` / `merged`。
  `explore-review` / `plan-review` / `pr` が人の判断を待つ HIL ゲート、それ以外は AI が自走する列
- **BREAKING** カード frontmatter から `explored` / `implStartedAt` / `stageOverride` を削除し、
  `startedAt`（人が着手を指示した時刻）と `skipGates`（人が事前に飛ばすと宣言したゲート）を追加する
- カード本文の `## レビュー` セクションを追記専用のレビューログとして定義する。
  エントリは 提出 / 再提出（AI が書く）と 承認 / 否決 / 中止（人が書く）の 5 種
- カード本文の `## 探索メモ` を探索工程の成果物として定義する。
  この見出しの存在が `explore-review` 列を立てる
- `POST /api/cards/:id/reviews` を追加する。否決には理由文を必須とする
- **BREAKING** 人がドラッグで動かせる遷移を `idea ⇄ exploring` の 1 つに縮める。
  承認 / 否決 / 中止は詳細パネルのボタンから行う
- `ai-pr-fixed` 列を廃し、同じ判定（最新コミット > 最新レビューコメント）を `pr` 列内のバッジに降ろす
- `verifying` 列を新設する。`tasks.md` が全完了かつ MR がまだ無い状態＝品質ゲートを回している最中
- 中止されたカードを既定でボードから畳む。列は増やさない

スコープ外:

- 列内の並び順を AI が付けること → `card-ordering` カードに分離済み
- 検証中に品質ゲートが落ちた事実の表示 → `loop-activity` カードに分離済み
- AI が MR を作る具体的な手順 → `gitlab-mr-loop` カードに分離済み
- `/loop` を回すスキル本体の実装 → `board-loop-skill` カードに分離済み

## Capabilities

### New Capabilities

- `board-stages`: カードのステージを 3 ソース（カードファイル・openspec・GitLab）から
  導出する規則と、人が手で動かせる範囲の決まり
- `card-review`: カード本文のレビューログの書式、ゲートの通過判定、
  人の判断を追記する API

`openspec/specs/` は現在空である。この change が最初の 2 つの capability を導入する。

### Modified Capabilities

なし。

## Impact

- **新規ファイル**: `src/cards/models/review.ts`, `src/cards/services/review-log.ts`,
  `src/cards/usecases/commands/append-review.command.ts`,
  `src/web/components/detail/ReviewActions.tsx`
- **削除ファイル**: `src/web/components/detail/ProgressActions.tsx`
- **変更ファイル**: `src/shared/schemas/common.ts`（`STAGES`）,
  `src/board/services/stage-resolver.ts`（`RULES` の全面差し替え）,
  `src/cards/models/card.ts` と `card.schema.ts`,
  `src/cards/repositories/fs-card.repository.ts`,
  `src/board/models/board-card.ts`, `src/board/usecases/queries/get-board.query.ts`,
  `src/cards/controllers/card.controller.ts`, `src/cards/composition.ts`,
  `src/web/` の型・列・詳細パネル
- **API**: `POST /api/cards/:id/reviews` を追加。
  `PATCH /api/cards/:id` から `explored` / `implStartedAt` / `stageOverride` が消え、
  `startedAt` / `skipGates` が入る。`GET /api/board` の `BoardCard` から
  `derivedStage` / `overridden` / `diverged` / `stageOverride` が消え、
  `aborted` / `gates` / `startedAt` / `skipGates` が入る
- **データ移行**: `.ai-board/cards/*.md` 16 枚の frontmatter。
  全枚が `explored: false` / `implStartedAt: null` のため機械的な置換で足りる
- **ドキュメント**: `CLAUDE.md`（ステージ導出・書き込み境界・API の 3 節）,
  `README.md`（判定表）, `.ai-board/cards/board-loop-skill.md`（AI のハードルール）
- **既存の挙動**: `stageOverride` は現在も API が値の指定を 400 で拒否しており、
  書けるのはファイルを手で編集した場合のみ。削除しても API の互換性は落ちない
- **新規の外部依存**: なし
