# ボードを縦スクロールのダッシュボードにする

## 提案

### Why

今のボードは 6 列のカンバンで、横に並んだ列を見渡して「人の判断待ち」を探す必要がある。
人が動くべきカードは ★ の 2 列（計画レビュー / PR中）に散らばっており、
判断の材料（計画の本文、`plan 提出` に書かれた判断待ちの点）は、カードを開いて右の詳細パネルで読むしかない。
列が横に並ぶため、画面が狭いと横スクロールも要る。

ボードを横幅固定（1040px）で縦にスクロールするダッシュボードに作り直す。
開いた瞬間に人の判断待ちが一番上に来て、その場で計画を読んで承認 / 否決できるようにする。

デザイン案: https://claude.ai/artifact/Rj9jkWTtRsKbV8eranz2WU

### What Changes

- ボードの画面を、上から次の区画を縦に積んだ 1 ページに置き換える。
  1. **ヘッダ（sticky）:** ブランド、GitHub の接続状態、6 段の件数帯。マスを押すと該当の区画へ飛ぶ。
     マスの下線の色は、今の列の帯色と同じく「そのステージを立てる情報源」を表す。
  2. **あなたの判断を待っている:** 計画レビューと PR中 のカード。
     計画レビューのカードには `plan 提出` / `再提出` のエントリ本文（判断待ちの点）を出し、
     「計画を読む」でその場に計画の本文とレビュー欄（承認 / 否決 / 中止）を開く。
     PR中 のカードには再レビュー待ちかどうかと PR へのリンクを出す。
  3. **AI が進めている:** 計画提案中と実装中のカード。3 列のグリッドに進捗バーを付ける。
     計画ファイルの最終更新から 3 日以上たったカードに「3 日動きなし」の印を出す。
     計画提案中のカードには「着手を戻す」ボタンを付ける。
  4. **アイデア:** 表形式。行のドラッグで並べ替え（`rank`）、検索で絞り込み、「着手」ボタンで `startedAt` を打つ。
  5. **マージ済み:** 表形式で、既定では折りたたむ。マージの新しい順に並べる。
  6. **中止:** 中止されたカードを折りたたんで置く（今のトップバーの「中止 N 件を表示」を置き換える）。
  7. **警告:** カードの無い計画ファイルなどをページ末尾の帯にまとめる。
- 列をまたぐドラッグをやめる。`アイデア ⇄ 計画提案中` の遷移は「着手」「着手を戻す」のボタンで行う。
  書き込む値（`startedAt`）と、動かせる先の判定（`droppableStages`）は変えない。
- 本文の編集と branch / PR の紐付けのため、今の詳細パネルは残す。カードのタイトルを押すと右から開く。
- `GET /api/board` の各カードに 3 つのフィールドを足す（既存のフィールドは変えない）。
  - `latestReview`: plan ゲートの最新エントリ（`{ at, kind, reason }` か `null`）。判断待ちの点と待ち時間に使う
  - `plan.updatedAt`: 計画ファイルの mtime（ISO 8601）。「動きなし」の判定と、PR の無いマージ済みカードの日付に使う
  - `mrState.mergedAt`: PR の `merged_at`。マージ済みの並び順と日付に使う

### 判断待ちの点

1. **判断待ち区画の並び順:** 待ち時間の長い順（`latestReview.at` の古い順。
   PR中 は `latestCommitAt`、無ければ `latestReview.at`）にする。
   他の区画は今と同じく `rank` の順。人の判断待ちは優先度より溜まった時間で片付けるほうが自然だと考えた。
   `rank` の順にそろえたいなら、そちらに変える。
2. **列をまたぐドラッグの廃止:** アイデアの表の中の並べ替えだけをドラッグで残し、
   着手と着手を戻すことはボタンに置き換える。`README.md` と `CLAUDE.md` の「人がドラッグで動かすのは 1 遷移だけ」も
   「人がボタンで動かすのは 1 遷移だけ」に書き直す。
3. **AI 作業中・判断待ちの区画での並べ替え:** これらの区画は並べ替えを受けない。
   `rank` はボード全体で 1 本の全順序なので、アイデアの段階で決めた優先度がそのまま持ち越される。
   後から AI 作業中の順を変えたくなったら、並べ替えを足す別カードにする。
4. **PR の修正コミット数:** デザイン案にあった「修正コミットが 3 つ」は出さない。
   件数を得るには PR ごとに `pulls/{n}/commits` の全ページを引く必要があり、ポーリングの負荷に見合わない。
   `resubmitted`（再レビュー待ちか）と最新コミットの日時だけを出す。

### Impact

- サーバ
  - `src/board/models/plan-state.ts` / `repositories/plan.repository.ts` — `updatedAt`（`fs.stat` の mtime）
  - `src/board/models/mr-state.ts` / `services/github-client.ts` — `mergedAt`
  - `src/board/models/board-card.ts` / `usecases/queries/get-board.query.ts` — `latestReview` / `plan.updatedAt` / `mrState.mergedAt`
  - `src/cards/services/review-log.ts` — ゲートの最新エントリを返す関数（`gateState()` と同じ規則で中止を除く）
- web
  - `src/web/App.tsx` — ボードの代わりにダッシュボードを置く
  - `src/web/components/dashboard/`（新規）— `Dashboard` / `PipelineStrip` / `InboxSection` / `WorkSection` / `IdeaTable` / `MergedTable` / `AbortedSection` / `WarningStrip`
  - `src/web/components/Board.tsx` / `Column.tsx` / `Card.tsx` — 削除
  - `src/web/components/CardDetail.tsx` と `detail/` — 詳細パネルは残す。`PlanSection` と `ReviewActions` を判断待ちの区画からも使う
  - `src/web/types.ts` / `styles.css`
- テスト: `plan.repository` の `updatedAt`、`github-client` の `mergedAt`、`review-log` の最新エントリ、`board.e2e` のレスポンス形
- ドキュメント: `README.md` / `CLAUDE.md` のドラッグの記述と `GET /api/board` の説明
- API 互換: フィールドが増えるだけで、既存のフィールドは変わらない

## 設計

### Context

ステージはサーバが導出して `BoardCard.stage` で返しており、UI は受け取ったステージでカードを振り分けるだけでよい。
区画への振り分けは表示の都合であり、導出の規則には触れない。

- 判断待ち = `plan-review` と `pr`（`STAGE_OWNER` が `human` で、`idea` を除いたもの）
- AI 作業中 = `planning` と `impling`
- アイデア = `idea`、マージ済み = `merged`
- 中止（`aborted`）は、どのステージにあっても中止の区画へ寄せる。今の UI が既定で畳んでいるのと同じ扱い

判断待ちの点は `## レビュー` の `plan 提出` のエントリ本文にある。
本文の解析はサーバの `review-log.ts` に閉じているので、UI で `## レビュー` を解析し直さず、サーバが最新エントリを返す。

### Goals / Non-Goals

**Goals:**

- 開いた最初の画面に、人の判断待ちの件数と中身が出ること
- 計画を読む → 承認 / 否決する、が詳細パネルを開かずに済むこと
- 横スクロールが出ないこと（1040px 固定。狭い画面では件数帯を 3 × 2 にし、各区画を 1 列に落とす）
- ステージの導出規則と、書き込みの境界（人 / AI）を一切変えないこと

**Non-Goals:**

- 「最近の動き」やスループットのグラフ（イベント履歴が要る。C 案の要素で、別カードにする）
- PR の修正コミット数（判断待ちの点 4）
- 計画の Markdown の整形表示（今の `PlanSection` と同じく等幅のまま出す）

### Decisions

- **`latestReview` は plan ゲートの、中止を除いた最新エントリにする。**
  `gateState()` が中止を判定から除くのと同じ理由で、中止は工程の進捗と直交する。
  中止されたカードは `aborted` で中止の区画へ寄るので、判断待ちの区画に中止の理由が出ることはない。
- **`updatedAt` は計画ファイルの mtime を使う。** カードの DB には更新時刻の列が無く、
  AI の作業の痕跡として一番近いのは計画ファイルのチェックボックスの更新である。
  列を足すマイグレーションより軽い。git checkout で mtime が変わることはあるが、
  「動きなし」の印が一時的に消えるだけで害は小さい。
- **「動きなし」の閾値は 3 日の定数にする**（`src/web/` 内）。設定にするほどの需要はまだ無い。
- **件数帯は `<a href="#sec-...">` のアンカーにする。** sticky のヘッダに隠れないよう `scroll-padding-top` を付ける。
- **並べ替えはアイデアの表の中だけ。** 今の `Column` の並べ替え（`moveTargetFor` / `applyMove` による先行表示、409 で巻き戻す）を `IdeaTable` に移す。
  挿入位置は行の中心の Y で決める（今の `dropIndexAt` と同じ）。
- **「着手」「着手を戻す」は今の `patchForStage` と同じ PATCH を送る。**
  ボタンは `card.droppableStages` にその先が含まれるときだけ出す。

### Risks / Trade-offs

- 列のドラッグに慣れた操作が無くなる → 着手はアイデアの行のボタン 1 つで済み、操作の数は増えない。
- `src/web/` は vitest の対象外 → 区画への振り分けと待ち時間の並べ替えを `src/shared/` の純関数に切り出し、
  そこにユニットテストを書く（`card-reorder.ts` と同じ置き方）。

## タスク

### 1. API を足す

- [x] 1.1 `review-log.ts` にゲートの最新エントリ（中止を除く）を返す `latestEntry()` を足し、ユニットテストを書く
- [x] 1.2 `PlanDoc` に `updatedAt` を足し、`FsPlanRepository` で `fs.stat` の mtime を読む。テストを足す
- [x] 1.3 `MrState` に `mergedAt` を足し、`GhForgeClient` で `merged_at` を写す。テストを足す
- [x] 1.4 `BoardCard` に `latestReview`、`BoardCardPlan` に `updatedAt`、`BoardCardMr` に `mergedAt` を足し、`get-board.query.ts` で組み立てる
- [x] 1.5 `board.e2e.test.ts` で 3 つのフィールドを検証する

### 2. 区画の振り分けを純関数にする

- [x] 2.1 `src/shared/dashboard-sections.ts` に、カードを区画へ振り分ける関数と、判断待ちを待ち時間の順に並べる関数を書く
- [x] 2.2 `src/shared/__tests__/dashboard-sections.test.ts` を書く（中止の寄せ方、PR中 の待ち時間のフォールバックを含む）

### 3. ダッシュボードの画面

- [x] 3.1 `web/types.ts` に新しいフィールドを足す
- [x] 3.2 `PipelineStrip`（sticky のヘッダと件数帯）
- [x] 3.3 `InboxSection`（判断待ちの点、計画のインライン表示、`PlanSection` と `ReviewActions` の再利用）
- [x] 3.4 `WorkSection`（進捗バー、「動きなし」、着手を戻す）
- [x] 3.5 `IdeaTable`（並べ替えのドラッグ、検索、着手）
- [x] 3.6 `MergedTable` と `AbortedSection`（折りたたみ）
- [x] 3.7 `WarningStrip`（カードの無い計画、GitHub の接続エラー、操作のエラー）
- [x] 3.8 `App.tsx` を差し替え、`Board.tsx` / `Column.tsx` / `Card.tsx` と使われなくなったスタイルを消す
- [x] 3.9 `styles.css` を書き直す（既存の配色トークンとダークモードはそのまま使う）

### 4. 仕上げ

- [x] 4.1 `README.md` / `CLAUDE.md` のドラッグの記述と `GET /api/board` の説明を直す
- [x] 4.2 `npm run typecheck && npm run lint && npm test` を通す
- [ ] 4.3 `npm run dev` と `npm run dev:web` で実際の画面を確かめる（ライト / ダーク、幅 400px）
