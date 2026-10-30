# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリは何か

計画ファイル駆動の開発のためのローカル Web ダッシュボード（横幅固定・縦スクロール）。
カードのステージは計画ファイル・レビュー要求（GitHub の PR）・カードの実態から**導出**される。
`stage` という値はどこにも保存しない。人の判断（着手・承認・否決・中止）も
カード上の痕跡として残り、それも導出の入力になる。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ 動作確認 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI        人 ★       人 ★        —
```

★ が人の判断を待つ HIL ゲート。計画レビューは計画を読み、動作確認はブランチを動かして振る舞いを確かめ、
PR中 はコードの差分を読む。人が動かすのは `アイデア ⇄ 計画提案中` の 1 遷移だけ（「着手」「着手を戻す」ボタン）。

スタックは TypeScript (ESM, Node >= 22.13。カードの保存に組み込みの `node:sqlite` を使う) / Express 5 + React 19 + Vite / Vitest。
サーバは `127.0.0.1:5673` にのみ bind するローカル専用ツールで、認証やレート制限は持たない。

## 品質ゲート

コミット前に必ず通す。

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

同じものを CI（`.github/workflows/ci.yml`）が PR と main への push で走らせる
（テストはカバレッジ閾値付きの `test:coverage`、加えて `build`）。
整形が崩れていたら `npm run format` で直す。
PR のレビューだけに効く指示は `REVIEW.md` に置く。

- `typecheck` は tsc を 2 回走らせる（`tsconfig.json` = サーバ、`tsconfig.web.json` = web）。
  片方だけ通っても不十分。
- テスト単体で走らせるとき: `npx vitest run src/board/services/__tests__/stage-resolver.test.ts`、
  名前で絞るなら `npx vitest run -t 'done'`。
- ビルドは `npm run build`（tsc → `dist/`、vite → `dist/web/`）。
- 開発時は `npm run dev`（サーバのみ、tsx watch）と `npm run dev:web`（Vite、`/api` を 5673 へプロキシ）。

## タスクは `.ai-board/board.db` にある

**このリポジトリ自身のバックログはボードのカードとして `.ai-board/board.db`（SQLite）に置かれている。**
何に着手するかを判断するときは、まずここを読む。1 行 = 1 カード。DB は git に載せない。
**ワークツリーで動かすと、メインのチェックアウトの `board.db` と `config.yaml` を共有する**
（`src/shared/git-worktree.ts` / `resolvePaths`）。計画ファイルはワークツリー（ブランチ）のものを読む。
ai-board 自身の開発でスキーマを変えるコードをワークツリーで動かすときは、`AI_BOARD_DB` で別の DB を指す。
共有の DB を新しい版に上げると、メインの古い ai-board が開けなくなる。

**読み書きは `ai-board card` の CLI で行う。DB を sqlite3 などで直接触らない。**
（開発中は `node dist/cli.js card ...`。先に `npm run build` が要る）

```bash
ai-board card list                 # 一覧（JSON、本文なし、rank 順）
ai-board card show <id>            # 1 枚を下の Markdown の形で
ai-board card body <id> < body.md  # 本文の差し替え（## レビュー のエントリは変えられない）
ai-board card branch <id> <name>   # ブランチの紐付け（--clear で外す）
ai-board card submit <id> [--gate <plan|verify>] [--resubmit] [--reason <text>]   # 提出 / 再提出（既定は plan）
ai-board card create --title <t> [--id <id>] < body.md     # アイデアカードの起票
ai-board status [--json]           # 導出したステージ・判断待ち・次の一手（サーバ不要）
```

`status` はサーバを起動せず、ボードと同じ組み立て（`createMrStateSource` → `getBoardQuery`）でステージを導出する。
PR の状態は `refresh()` を 1 回だけ待って引き、`branch` から解決した PR 番号の書き戻しもサーバと同じく起きる。
次の一手は `src/board/services/next-action.ts` の `pickNextAction`（実装中 → 計画提案中、列の中は `rank` の順）が決める。
手は `plan` / `revise-plan`（計画提案中）と `implement` / `revise-impl` / `ready`（実装中）の 5 種類で、
実装中の手は verify ゲートの状態で分ける（未提出 → `implement`、否決 → `revise-impl`、人の承認 → `ready`）。
`gateState` は飛ばす宣言も approved で返すので、人の承認とは `skipGates` で見分ける（飛ばす宣言なら `implement`）。

`card show` の出力（DB の列を frontmatter の形で表したもの）:

```yaml
---
id: board-search # 不変。生成後は変えない。ファイル名と一致する kebab-case
title: カードを絞り込めるようにする
created: '2026-09-04T06:48:23.416Z'
startedAt: null # 人が着手を指示した時刻（人が打つ）
skipGates: [] # 人が事前に見ないと宣言したゲート（plan / verify）
branch: null
mr: null # レビュー要求の番号（branch から自動解決して書き戻す）
rank: 1500 # 並び順（任意）。小さいほど上。人が並べ替えたときだけ書かれる
---
```

本文の見出しにも意味がある。`## レビュー` は人の判断を残す追記専用ログで、
ステージ導出の入力になる。`## 探索メモ` は自由記述であり、導出には効かない。

`id` が不変で `branch` / `mr` が進行に応じて後から埋まることで、
アイデアメモ → 計画 → ブランチ → PR → archive が 1 本の線につながる。
計画は `.ai-board/plans/<id>.md` に同じ名前で置かれる。ID がファイル名を決めるので、
紐付けのためのフィールドは持たない。
CLI の書き込みはサーバが `PRAGMA data_version` の変化で拾い、SSE 経由でブラウザへ即座に反映される
（`src/infrastructure/database.ts` の `watchDatabase`）。サーバ自身の書き込みは
`data_version` に現れないので、リポジトリの `onWrite` から通知する。

移行前の `.ai-board/cards/<id>.md` は `ai-board import` で取り込む。
Markdown 表現（`card-markdown.ts`）はこの取り込みと `card show` の出力にだけ使う。

## 書き込み境界

「誰の書き込みか」で分かれる。混同しないこと。

| 主体            | `.ai-board/plans/`                           | カード（`.ai-board/board.db`）                 |
| --------------- | -------------------------------------------- | ---------------------------------------------- |
| ai-board サーバ | **read-only**                                | 書く（画面の操作・PR 番号の書き戻し）          |
| AI エージェント | 書く（計画・タスクの更新・archive への移動） | `ai-board card` 経由で本文・ブランチ・提出のみ |

エージェントが**やってはいけないこと**（ループの作業者 `.claude/agents/board-worker.md` のハードルールと同じ）:

- `startedAt` を自分で打たない。これは人が着手を指示する合図。
- `## レビュー` に書いてよいのは 提出 / 再提出 だけ。承認 / 否決 / 中止 は人が書く。
  plan でも verify でも同じ。動作確認を頼んだ（`verify 提出`）後に、自分で動かした結果をもって承認しない。
- `skipGates` を自分で足さない。動作確認を飛ばすかどうかも人が決める。
- `rank` を書かない。並び順は人が決める優先度で、エージェントは上から読むだけ。
  アイデアの表の区切り線（「次にやる」/「あとで考える」）も同じ扱い。
- 計画レビュー / 動作確認 / PR中 のカードのステージに触らない。
- 品質ゲートを通らないままコミットしない。

このうちカードに関わるものは `ai-board card`（`src/cards/cli/card-cli.ts`）が構造で強制する。
CLI には `startedAt` / `rank` / `skipGates` を書く入口も、承認 / 否決 / 中止を追記する入口も無く、
`body` は `## レビュー` のエントリが変わる差し替えを拒否する。**CLI に入口を足すときはこの境界を崩さない。**

ステージを直接指定する入力口は存在しない。列を動かしたければ、その列を成立させる実態
（`startedAt` の打刻、計画ファイルの作成、`## レビュー` への提出・承認の追記）を作る。

## ステージ導出

核は `src/board/services/stage-resolver.ts` の純関数。
7 段の判定表と各ルールの理由はそのファイルの docstring にある（README にも同じ表がある）。
**変更するならまずここを読む。** ルールは制御構造ではなく `RULES` 配列の順序で表現され、
「上から評価して最初に真になったものが勝つ（＝最も進んだステージ）」を意味する。

ゲートの状態は `src/cards/services/review-log.ts` が本文の `## レビュー` から読む。
ゲートは計画を読む `plan` と、実装を動かして確かめる `verify` の 2 つ（`REVIEW_GATES`）。
廃止した `explore` のエントリは規定外として黙って無視される。
`gateState()` はゲートごとの最新エントリ 1 件で決まり、中止のエントリは判定から除く
（中止は工程の進捗と直交する終端の軸で、通過済みのゲートを巻き戻さない）。

守るべきは列の所有権の分割。

| 列                    | ステージを立てるもの                     | 領分 |
| --------------------- | ---------------------------------------- | ---- |
| アイデア / 計画提案中 | `startedAt` の打刻                       | 人   |
| 計画レビュー          | 計画ファイル、または Draft の PR         | AI   |
| 実装中                | `## レビュー` の plan 承認               | 人   |
| 動作確認              | `## レビュー` の verify 提出             | AI   |
| PR中                  | PR が opened かつ Draft でない           | AI   |
| マージ済み            | 計画が archive 済み、または PR が merged | AI   |

UI が `startedAt` を書き換えるのは「着手」「着手を戻す」のボタンだけ。列をまたぐドラッグは無く、
ドラッグはアイデアの表の中の並べ替え（`rank`）と区切り線の移動にだけ使う。承認 / 否決 / 中止はボタンで
`POST /api/cards/:id/reviews` を呼び、本文への追記になる（`gate` に `plan` / `verify` を取る）。
`skipGates` を画面から書くのは、詳細パネルの「動作確認を飛ばす」のチェックボックス（`verify` の出し入れ）だけ。

アイデアの表の区切り線は `rank` と同じ物差しの値を 1 つだけ持つ（DB の `idea_divider`）。
並べ替えの中ではカードと同じ 1 項目（`DIVIDER_ID`）として扱い、隙間が尽きた振り直しでも一緒に振り直す
（`src/cards/usecases/commands/move-in-order.ts`）。区切り線だけの分岐をここに足さない。

画面の区画（判断待ち / AI 作業中 / アイデア / マージ済み / 中止）への振り分けと並び順は
`src/shared/dashboard-sections.ts` の純関数にある。ステージの導出とは別物で、見せ方だけを決める。
`src/web/` はテストの対象外なので、画面のロジックを足すときはここへ切り出してテストを書く。
「`startedAt` を外したときに残るステージ」（AI の成果物とレビュー記録が課す下限）より
前へは戻せない（`resolveFloorStage` / `droppableStages`）。

否決の差し戻しに専用ルールは無い。ゲートが差し戻し中のときレビュー行と承認行が両方外れ、
1 つ手前の AI 列へ自然に落ちる。**ここに `if` を足したくなったら設計を疑う。**
verify も同じで、`verifying` のルールは「plan 承認済み かつ verify が submitted」の 1 本だけである。
否決・承認・飛ばす宣言のどれでも `verifying` が外れて 実装中 に落ちる。承認後に Ready にするのは AI の作業なので、
AI の列（実装中）で待つ。

判断待ちの区画が出す提出の本文と待ち始めた時刻は、`latestReview` から取る。
`latestReview` は「その列が待っているゲート（`GATE_OF_STAGE`）の最新エントリ、無ければゲートを通じた最新」で、
どのゲートのものかを `gate` に持つ。

計画ファイルは `src/board/repositories/plan.repository.ts` が読む。
ファイル名がそのままカード ID なので、ID として不正な名前のファイルは警告して読み飛ばす
（ここで例外を投げるとボード全体が 500 になり、置き場所を間違えた 1 ファイルで画面が死ぬ）。

**計画ファイルが存在するだけで計画レビューの列が立つ。** エージェントが書き始めた時点で
列が動くが、本来のゲートは本文の `## レビュー` に書かれる `plan 提出` であり、
ファイルの存在は「ログの欠落で人待ちを取りこぼさない」ための保険である。
「空ファイルは無視する」といった条件を足さない。

計画と実装は同じ 1 本の PR に載る。AI は計画をコミットした時点で **Draft の PR** を出し、
人はその PR で計画を読む。ボードは計画の本文を持たず（`GET /api/plans/:id` は廃止した）、
PR へのリンクだけを出す。計画ファイルはブランチにあり、ボードを動かすチェックアウトからは
見えないことが多いので、Draft の PR も計画レビューの列を立てる。Ready にした時点で PR中 へ進む。
動作確認を頼む時点の PR も Draft のままだが、Draft の PR が立てる計画レビューのルールは plan が未承認のときにしか
当てはまらないので、計画レビューへは巻き戻らない。

## レイヤー構成と規約

```
src/
  app.ts                Express アプリケーションファクトリ
  server.ts / cli.ts    起動（cli.ts は引数解析とブラウザ起動）
  shared/               Result<T,E>・Branded Types・設定・ミドルウェア
  cards/                カードの CRUD コンテキスト
  board/                3ソース統合・ステージ導出コンテキスト
  infrastructure/       ファイル監視・SSE・GitHub ポーリング
  web/                  React + Vite のダッシュボード UI
```

各コンテキストは `models/ errors/ repositories/ usecases/ controllers/ composition.ts` を持つ。

- **usecase は例外を投げず `Result<T, E>` を返す**（`src/shared/result.ts`）。
- **エラーは discriminated union**（`{ type: 'CardNotFound', id }`）で表し、
  controller が `*-error-mappings.ts` の `switch` で HTTP ステータスへ変換する。
  エラー種を増やしたらマッピングの `switch` も網羅する（型が漏れを検出する）。
- **依存はコンテキストごとの `composition.ts`（Composition Root）で構成する。**
  usecase やリポジトリの中で `new` して依存を作らない。
- **ID は Branded Type**（`CardId` / `MergeRequestIid`）。
  生の string を渡さず `createCardId` などのファクトリを通す（`src/shared/schemas/common.ts`）。
- 入力検証は Zod スキーマ（`models/schemas/`）。`PATCH` では `undefined`（未指定＝変更しない）と
  `null`（値を消す）を区別する。

### 型とビルドの制約

- サーバは `module: NodeNext` なので**相対 import に `.js` 拡張子が必要**（`./card.js`）。
- web は `moduleResolution: Bundler`。`src/shared/` は両方の tsconfig に含まれるため、
  **どちらのモードでも通る書き方**にする（Node 専用 API を持ち込まない）。
- パスエイリアスは使わない。相対パスのみ。
- 両方で `strict` + `noUncheckedIndexedAccess`。配列アクセスは `undefined` を考慮する。

### ESLint がエラーにするもの

`complexity: 12` / `max-lines-per-function: 120` / `@typescript-eslint/consistent-type-imports`
（型は `import type`）/ `no-console`（`warn` と `error` のみ許可）。
テストファイルは `max-lines-per-function` と `no-explicit-any` が緩められている。

### テスト

- **`src/**/__tests__/**/*.test.ts` に置く。** この glob 外は vitest が黙って無視する。
- カバレッジ閾値は lines/functions/statements 80%、branches 75%（`npm run test:coverage`）。
- API は supertest で e2e を書く（`src/board/controllers/__tests__/board.e2e.test.ts`）。
- **`src/web/` は vitest の対象外。** `environment: node` で、include glob は `.ts` のみ（`.tsx` を拾わない）、
  カバレッジからも除外され、jsdom も testing-library も入っていない。
  UI の変更は typecheck と lint で担保する。

## レビュー要求の取得先

取得先は GitHub の Pull Request だけ（GitLab 連携は廃止した）。
`.ai-board/config.yaml` に `github:` を書いたときだけ有効になる。
欠けていれば連携は無効になり `PR中` / `マージ済み` の列が空になるだけでボードは動く。

**アクセストークンは扱わない。** 問い合わせは `gh api` の実行として行い、
認証はログイン済みの CLI に委ねる。トークンを設定ファイル・環境変数から読む経路は無い。
CLI の有無とログイン状態は起動時に 1 度だけ確かめ（`ForgeClient.checkAuth`）、
使えなければ理由付きで `disabled` にする。

CLI の実行は `src/infrastructure/cli-runner.ts` に閉じる。**shell を介さず引数は配列で渡す。**
カードの `branch` は人もエージェントも自由に書ける場所であり、文字列連結でコマンドを
組み立てるとカードを書ける者が任意のコマンドを実行できる。
stderr は本文を載せず `(HTTP 404)` の数字だけを取り出して 404 判定に使う。

GitHub の PR は `state` が `open` / `closed` の 2 値しかなく、**マージ済みも `closed`** で返る。
区別は `merged_at` の有無で付ける（`toLifecycleState`）。ここを取り違えるとカードが
`merged` へ進まない。レビューコメントは issue comment と review comment の 2 か所に
分かれるため、合算して「人が書いた最新のコメント」とする。
どちらの一覧も既定は古い順の 1 ページ目だけで、`issues/{n}/comments` は `sort` /
`direction` を受け付けない（受けるのはリポジトリ単位の `issues/comments` の方）。
並び順に頼らず `gh api --paginate` で全ページ引いて最大値を取る。
最新コミットは `pulls/{n}/commits` ではなく `head.sha` を直接引く（件数で取り逃がさない）。
自動生成のコメントを示すフラグは無く、`user.type === 'Bot'` で外す。

PR 一覧の全件取得はページングで取りこぼすため使わず、カード単位で問い合わせる。

カードの `mr` が分かっていれば番号で、無ければ `branch` から解決して書き戻す（`ForgePoller.fetchFor`）。

かつてはカードに番号の出どころ（GitLab / GitHub）を記録する `forge` 列があった。
GitLab の MR !1 と GitHub の PR #1 は別物で、番号をそのまま引くと
**列は正しく埋まったままリンクだけが別の PR を指す**。
そのため DB のマイグレーション（v2・v3）で、GitHub のものと確かめられない番号
（`forge: gitlab`、および `forge` が無く `branch` があるもの）を消してから列を落とし、
`branch` から解決し直させている。`ai-board import` も `forge: gitlab` の番号は捨てる。

## API

| メソッド | パス                     | 用途                                                    |
| -------- | ------------------------ | ------------------------------------------------------- |
| `GET`    | `/api/board`             | 全カード＋導出ステージ＋計画の進捗 / レビュー要求の情報 |
| `POST`   | `/api/cards`             | 新規アイデアカード作成                                  |
| `PATCH`  | `/api/cards/:id`         | frontmatter の部分更新                                  |
| `PUT`    | `/api/cards/:id/body`    | 本文の差し替え                                          |
| `POST`   | `/api/cards/:id/reviews` | `## レビュー` へのエントリ追記（承認 / 否決 / 中止）    |
| `POST`   | `/api/cards/:id/move`    | 直前・直後のカード（`after` / `before`）の間へ並べ替え  |
| `POST`   | `/api/idea-divider/move` | アイデアの表の区切り線を直前・直後のカードの間へ動かす  |
| `GET`    | `/api/events`            | SSE。ファイル変更・ポーリング結果を push                |

## 計画ファイル

計画は `.ai-board/plans/<card-id>.md` に置く。ファイル名がカード ID と一致することで
カードと紐付くので、frontmatter に紐付け用のフィールドは無い。

計画を書き、タスクはチェックボックス（`- [ ]` / `- [x]`）で
並べる。カードのプログレスバーはこの行を数えている（インデントされたサブタスクも
親と同じように数える）。チェックボックスの無い計画でもステージは動く。

1 周の流れ:

1. 人が `startedAt` を打つ（＝計画提案中へ）
2. AI が計画を立て、`.ai-board/plans/<id>.md` に書いてコミットし、
   push して `gh pr create --draft` で Draft の PR を出す。`ai-board card branch <id> <branch>` で
   ブランチを紐付け、`ai-board card submit <id>` でカード本文の `## レビュー` に `plan 提出` を追記する
   （＝計画レビューへ）
3. 人が Draft の PR で計画を読み、判断待ちの区画のボタンで承認 / 否決する（＝実装中へ）
4. AI が同じブランチでタスクを倒し、AI レビューまで済ませる。PR を Draft のまま
   `ai-board card submit <id> --gate verify --reason "<動かす手順と動かした結果>"` で `verify 提出` を追記する
   （＝動作確認へ）。手順は計画の `## 動作確認の手順` をもとに、実装を経て変わった点と、確かめられなかった点も書く
5. 人がブランチを手順どおりに動かし、判断待ちの区画のボタンで承認 / 否決する。
   否決なら AI が理由を読んで直し、`--resubmit` で頼み直す（手順 4 の提出へ戻る）
6. 承認されたら AI が計画を `.ai-board/plans/archive/<id>.md` へ `git mv` してコミットしてから、
   `gh pr ready` で Ready にする（＝PR中へ）
7. 人が PR をマージする（＝マージ済みへ。archive の移動も同時に main に入る）

人が詳細パネルで「動作確認を飛ばす」に印を入れた（`skipGates` に `verify` がある）カードは、手順 4・5 を通らず、
AI レビューの後にそのまま手順 6 へ進む。

計画の確認は Draft の PR と計画レビューのゲートで人が行うので、Plan モードの承認は要らない。
archive は別の PR にしない。マージと同時に main に入れば、GitHub が引けないときや
`github:` の無いリポジトリでも マージ済み が立つ。

手順 2・4・6 と否決後の直しは `.claude/skills/board-loop/SKILL.md` のスキルが 1 周 1 手ずつ作業者に渡して進める。
`/loop 5m /board-loop` で間隔運転する。何をするかは `ai-board status --json` の `next` に従い、
GitHub に接続できないとき（`forge.status` が `connected` でないとき。`github:` が無いときも含む）は
`status` が `next` を `null` にするので、ループは何もせずに止まる。

ループを回すセッションは**監視役**で、カードの作業は自分でしない。次の一手を選び、
その 1 手を作業者のサブエージェント（`.claude/agents/board-worker.md`）に渡して、返ってきた数行の報告を伝えるだけにする。
前のカードで読んだコードや決めた事柄を、次のカードの作業に持ち込まないためである。
作業者に渡すのはカード ID・手の種類・メインのチェックアウトのパスだけで、作業者はカード本文・計画・PR を自分で読み直す。
作業者が動いている間の周は、`ListAgents` で見て何もせずに終わる。

作業者には監視役の会話が見えない。**ループに伝えたい補足は、会話ではなくカード本文の `## 探索メモ` に書く。**

成果物は日本語で書く。

## コミット

日本語の Conventional Commits。

```
feat: GitHub の PR からレビューコメントの件数を引く
chore: 未着手カードの startedAt を null に戻す
docs: GitHub 連携の change を起票する
```
