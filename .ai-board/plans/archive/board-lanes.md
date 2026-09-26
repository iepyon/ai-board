# レーンを HIL ゲート付きの 9 列に作り直す

> openspec の change から移した計画。見出しは 1 段下げてある。

## 提案

### Why

現行の 7 列（`idea` / `explored` / `proposed` / `impling` / `ai-pr` / `ai-pr-fixed` / `done`）は、
「工程がどこまで進んだか」と「いま誰の番か」を 1 本の軸に畳んでいる。
`explored` は "探索が済んだ" と "人の承認待ち" を兼ね、`proposed` も `ai-pr` も同じ二重性を持つ。

ボードを `/loop` で回す前提に立つと、この二重性が運用上の問題になる。
人が朝ボードを開いたときに「自分が手を動かすべきカード」が一目で分からず、
AI 側も「どこで止まるべきか」を列から読み取れない。

さらに現状では、人が下した判断（承認した・否決した・その理由）がどこにも残らない。
`explored` フラグは「探索が済んだ」ことは言えても「人が見て良しとした」ことは言えず、
否決の理由に至っては記録する場所そのものが存在しない。

### What Changes

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

### Capabilities

#### New Capabilities

- `board-stages`: カードのステージを 3 ソース（カードファイル・openspec・GitLab）から
  導出する規則と、人が手で動かせる範囲の決まり
- `card-review`: カード本文のレビューログの書式、ゲートの通過判定、
  人の判断を追記する API

`openspec/specs/` は現在空である。この change が最初の 2 つの capability を導入する。

#### Modified Capabilities

なし。

### Impact

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

## 設計

### Context

動機は proposal.md の Why を参照。要件は `specs/board-stages/spec.md` と
`specs/card-review/spec.md` を参照。

現行実装の制約:

- ステージ導出の核は `src/board/services/stage-resolver.ts` の純関数群。
  ルールは制御構造ではなく `RULES` 配列の順序で表され、「上から評価して最初に真に
  なったものが勝つ」を意味する。この構造は保つ
- ai-board サーバは `openspec/` に対して read-only。`openspec/` へ書けるのは
  openspec CLI と AI エージェントだけで、サーバが書けるのは `.ai-board/` だけである
- 人の判断（承認・否決）はファイルシステムにも GitLab にも痕跡を残さない。
  「すべて導出する」を貫くには、痕跡を作る場所が要る
- カードは人がエディタで直接編集してよいファイルであり、ファイル監視 → SSE で
  ブラウザへ反映される。手書きの揺れで読めなくなる設計にはできない

### Goals / Non-Goals

**Goals:**

- 「ステージという値をどこにも保存しない」を維持したまま、人の判断を導出の入力にする
- 新しいファイル形式・新しい保存場所を増やさない
- 否決の理由を、AI が次の周回で読める形で残す
- ルールの表現を `RULES` 配列のまま保ち、否決の差し戻しに専用の分岐を作らない

**Non-Goals:**

- レビューの履歴を構造化データとして検索・集計すること。ログは読めれば足りる
- 複数人でのレビュー（誰が承認したかの記録）。ローカル専用ツールであり利用者は 1 人である
- `pr` ゲートのレビュー内容をカードへ取り込むこと。GitLab 側が正である

### Decisions

#### 人の判断の置き場所をカード本文の `## レビュー` にする

**選んだ理由**: カード本文は ai-board サーバが書ける唯一の場所であり、かつ
AI エージェントも CLAUDE.md の書き込み境界で本文の編集を許されている。
人が直接エディタで読み書きもできる。API・AI・人の 3 者が同じ場所を共有できるのはここだけである。

**代替案**:

- `frontmatter` に `reviews:` 配列を持つ → frontmatter が重くなり、
  理由文が複数行になると手編集が辛い
- `.ai-board/reviews/<id>.jsonl` に分離する → カードをエディタで開いたときに
  理由が見えない。カードを 1 ファイルで完結させる現在の設計と食い違う

#### 探索の成果物を `## 探索メモ` の存在で表す

openspec には探索工程の artifact が無い（`/opsx:explore` は会話であって成果物を作らない）。
`openspec/changes/<name>/exploration.md` を独自に足すと、openspec の artifact スキーマ外の
ファイルを増やすことになり、CLI の `status` や `validate` の管理外に落ちる。

カード本文の `## 探索メモ` は既に `.ai-board/cards/gitlab-mr-loop.md` が使っている慣習であり、
明文化するだけで済む。

**トレードオフ**: 見出しの存在だけを見るため、空の `## 探索メモ` でも探索レビューへ進む。
中身の質を機械的に判定する手段は持たない。これは人のレビューが担う。

#### 否決からの復帰を AI の「再提出」追記で表す

否決のあと AI が成果物を直したことを、どうやって検出するか。

ファイルの mtime 比較は成立しない。レビュー記録を書く行為そのものでカードファイルの
mtime が動くため、「レビューより後に成果物が更新された」を区別できない。

AI が `再提出` エントリを追記する方式を採る。これは「成果物を出したという事実の報告」であり、
MR にコミットを push するのと同じ性質の行為で、人の承認の代行にはあたらない。
`.ai-board/cards/board-loop-skill.md` のハードルールを侵さない。

**代替案**: 成果物ごとにハッシュを持ち、レビュー時点のハッシュと比較する
→ カードファイルに導出用のキャッシュを持つことになり、「実態から導出する」原則を崩す。

#### `pr` ゲートだけレビューログを持たない

MR の承認とマージは GitLab 側の実態であり、カード本文に写す必要が無い。
痕跡がある場所を正とする原則の帰結として、この非対称は意図的に残す。

したがってレビューログを読むゲートは `explore` と `plan` の 2 つ、
人が判断するゲートは `pr` を含めて 3 つ、という数の食い違いが生じる。
`skipGates` に指定できるのも `explore` と `plan` の 2 つに限る。

#### スキップは frontmatter での事前宣言にする

レビュー列に来てからボタンで 1 回だけ通す方式は採らない。導出の入力が
「宣言されているか」と「ログにあるか」の 2 つに増えるため。

事前宣言なら、カードはレビュー列に一瞬も滞留せず AI が走り抜ける。
`/loop` を夜間に回す用途ではこちらが本来欲しい挙動である。

「見ずに通した」ことを記録に残したい場合は、承認エントリの理由文に書けばよい。

#### `verifying` を tasks の全完了で立てる

`TaskProgress`（`completed` / `total`）は既に読み取られているが、どのルールも使っていなかった。
新しい観測点を足さずに `実装中` と `検証中` を分けられる。

`total === 0` を全完了として扱わない。tasks.md がまだ書かれていないだけの change を
検証中へ飛ばしてしまうためである。

#### `stageOverride` を削除する

人の判断がすべて実態として記録されるようになり、実態と食い違う値を置く動機が消える。
現行でも API は値の指定を 400 で拒否しており、書けるのはファイルの手編集だけだった。
乖離バッジ（`diverged` / `overridden`）も同時に消える。

### Risks / Trade-offs

- **手書きのレビュー見出しが規定の書式から外れると黙って無視される** → 書式を
  `### <ISO 8601> <ゲート> <種別>` の 1 行に固定し、UI のボタンからは必ず正しい形で
  追記する。人が手で書くのは例外的な経路とする。ボード全体が読めなくなるより、
  1 件が無視されるほうが害が小さい
- **`proposal.md` があるのに plan の提出記録が無い状態が起こりうる**（AI が書き忘れる）
  → 成果物の存在を正とし、記録が無くても `plan-review` に着地させる。
  人待ちを取りこぼさない側に倒す
- **同時刻のエントリが複数あると順序が曖昧になる** → 同時刻なら後に書かれたほう
  （ログ中で後ろにあるほう）を最新とする。追記専用なので実用上これで足りる
- **中止したカードが既定で見えなくなる** → 件数をトップバーに出し、トグルで表示できるようにする。
  カードファイル自体は削除しない
- **列が 9 本に増え、横幅が足りなくなる** → 列の最小幅を見直す。
  カードの絞り込み（`board-search` カード）は別の change に分離済み

### Migration Plan

1. `src/cards/` の新しい純関数（レビューログの解析と追記）を先に足す。既存の挙動は変わらない
2. カードスキーマを入れ替える。この時点で `src/board/` と `src/web/` が型エラーになる
3. `STAGES` と `stage-resolver.ts` を差し替える
4. `BoardCard` と `get-board.query.ts` を追従させ、サーバ側の型とテストを通す
5. レビュー追記 API を足す
6. `src/web/` の型・列・詳細パネルを追従させる
7. `.ai-board/cards/*.md` 16 枚の frontmatter を移行する

移行は機械的な置換で足りる。16 枚すべてが `explored: false` / `implStartedAt: null` であり、
`explored: true` や `implStartedAt` が非 null のカードは存在しない。
規則だけは定めておく（`explored: true` は着手時刻に作成時刻を入れて explore 承認を追記、
`implStartedAt` が非 null なら plan 承認を追記）。

ロールバックは revert で足りる。カードファイルの frontmatter が旧スキーマへ戻るため、
`startedAt` / `skipGates` は失われるが、16 枚とも初期値のままなので実害は無い。

ステップ 2 と 3 は単体で `npm run typecheck` が通らない。コミットは分けるが、
ステップ 6 まで到達して初めて全ゲートが揃う。

## タスク

詳細な手順・テストコード・差分は `docs/superpowers/plans/2026-09-11-board-lanes.md` にある。
ここは進捗の追跡単位として、その 9 タスクを検証方法つきで並べたもの。

### 1. レビューログ

- [x] 1.1 `src/cards/models/review.ts` に `ReviewGate` / `ReviewKind` / `ReviewEntry` / `GateState` を定義し、`npm run typecheck` が通ることを確認する
- [x] 1.2 `src/cards/services/review-log.ts` に `parseReviewLog` / `gateState` / `isAborted` / `hasExploreNote` を実装し、`npx vitest run src/cards/services/__tests__/review-log.test.ts` が通ることを確認する（書式の壊れた見出しを無視するケース、他ゲートが混ざらないケース、`skipGates` で通過扱いになるケースを含む）
- [x] 1.3 `appendReviewEntry` を実装し、追記した結果を `parseReviewLog` が読み戻せることをテストで確認する（レビュー見出しが無い本文、既存セクションへの追記、後ろに別セクションがある場合の 3 経路）

### 2. カードスキーマ

- [x] 2.1 `Card` から `explored` / `implStartedAt` / `stageOverride` を外し `startedAt` / `skipGates` を足す。`CardFrontmatterSchema` と `UpdateCardMetaInputSchema` を追従させ、`AppendReviewInputSchema`（否決に理由文を必須とする refine 付き）を足す
- [x] 2.2 `fs-card.repository.ts` と `create-card.command.ts` を追従させ、`npx vitest run src/cards/` が通ることを確認する。`skipGates` の往復と、`skipGates` を持たない既存ファイルが空配列として読めることをテストで確認する

### 3. ステージ導出

- [x] 3.1 `src/shared/schemas/common.ts` の `STAGES` を 9 段へ入れ替える
- [x] 3.2 `stage-resolver.ts` の `RULES` を差し替え、`HUMAN_STAGES` を `['idea','exploring']` へ縮め、`hasFixAfterReview` を export する。`npx vitest run src/board/services/` が通ることを確認する（9 段すべての導出、否決による差し戻し 2 経路、tasks 0 件を全完了扱いしないこと、`droppableStages` が下限で空になることを含む）

### 4. ボード読み取り

- [x] 4.1 `BoardCard` から `derivedStage` / `overridden` / `diverged` / `stageOverride` / `explored` / `implStartedAt` を外し、`aborted` / `gates` / `startedAt` / `skipGates` を足す。`BoardCardMr` に `resubmitted` を足す
- [x] 4.2 `get-board.query.ts` を追従させ、`npm run typecheck`（サーバ側）と `npx vitest run` が通ることを確認する。e2e でレビューログから導出したステージが返ること、削除したフィールドがレスポンスに現れないことを確認する

### 5. レビュー API

- [x] 5.1 `append-review.command.ts` を実装し、composition root に登録する。`npx vitest run -t appendReviewCommand` が通ることを確認する
- [x] 5.2 `POST /api/cards/:id/reviews` を足し、e2e で確認する（承認で `planning` へ進む / 理由なし否決が 400 / 理由付き否決で `exploring` へ戻り本文に理由が残る / 中止で `aborted` になる / 存在しないカードが 404）

### 6. ボード UI

- [x] 6.1 `src/web/types.ts` の `Stage` / `STAGE_LABELS` / `STAGE_OWNER` / `STAGE_SOURCE` / `GATE_OF_STAGE` / `BoardCard` を差し替え、`api.ts` に `appendReview` を足す
- [x] 6.2 `Board.tsx` の `patchForStage` を `idea ⇄ exploring` の 1 遷移へ縮め、`stageOverride` の解除処理を消す。`Column.tsx` の列見出しを `STAGE_OWNER` ベースにする
- [x] 6.3 `ReviewActions.tsx` を新設して `ProgressActions.tsx` を削除し、`CardDetail.tsx` / `StageSection.tsx` / `CardBadges.tsx` / `App.tsx`（中止カードの折り畳み）を追従させる。`npm run typecheck && npm run lint && npm test` が全部通ることを確認する
- [x] 6.4 `npm run dev` と `npm run dev:web` を立てて目視で確認する。9 列が並ぶこと / アイデア ⇄ 探索中 のドラッグが往復できること / 探索メモを書くと探索レビューへ移り掴めなくなること / 否決すると探索中へ戻り理由が本文に残ること / 中止するとカードが畳まれトグルで戻せること

### 7. 移行とドキュメント

- [x] 7.1 `.ai-board/cards/*.md` 16 枚の frontmatter を移行し、`grep -l 'explored\|implStartedAt\|stageOverride' .ai-board/cards/*.md` が何も返さないことを確認する
- [x] 7.2 `.ai-board/cards/board-loop-skill.md` のハードルールを書き換える（`startedAt` を自分で打たない / `## レビュー` に書いてよいのは提出と再提出だけ / `skipGates` を自分で足さない）
- [x] 7.3 `CLAUDE.md` と `README.md` のステージ導出の節・書き込み境界の表・API の表を 9 列に合わせて書き換え、`npm run typecheck && npm run lint && npm test` が通ることを確認する
