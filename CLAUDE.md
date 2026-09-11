# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリは何か

OpenSpec 駆動開発のためのローカル Web カンバン。
カードのステージは `openspec/` ディレクトリ・GitLab・カードファイルの実態から**導出**される。
`stage` という値はどこにも保存しない。人の判断（着手・承認・否決・中止）も
カードファイル上の痕跡として残り、それも導出の入力になる。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ 検証中 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI        AI      人 ★        —
```

★ が人の判断を待つ HIL ゲート。人がドラッグで動かすのは `アイデア ⇄ 計画提案中` の 1 遷移だけ。

スタックは TypeScript (ESM, Node >= 20) / Express 5 + React 19 + Vite / Vitest。
サーバは `127.0.0.1:5673` にのみ bind するローカル専用ツールで、認証やレート制限は持たない。

## 品質ゲート

`openspec/config.yaml` が定める検証コマンド。コミット前に必ず通す。

```bash
npm run typecheck && npm run lint && npm test
```

- `typecheck` は tsc を 2 回走らせる（`tsconfig.json` = サーバ、`tsconfig.web.json` = web）。
  片方だけ通っても不十分。
- テスト単体で走らせるとき: `npx vitest run src/board/services/__tests__/stage-resolver.test.ts`、
  名前で絞るなら `npx vitest run -t 'done'`。
- ビルドは `npm run build`（tsc → `dist/`、vite → `dist/web/`）。
- 開発時は `npm run dev`（サーバのみ、tsx watch）と `npm run dev:web`（Vite、`/api` を 5673 へプロキシ）。

## タスクは `.ai-board/cards/` にある

**このリポジトリ自身のバックログはボードのカードとして `.ai-board/cards/<id>.md` に置かれている。**
何に着手するかを判断するときは、まずここを読む。1 ファイル = 1 カード。

```yaml
---
id: board-search        # 不変。生成後は変えない。ファイル名と一致する kebab-case
title: カードを絞り込めるようにする
created: '2026-09-04T06:48:23.416Z'
startedAt: null         # 人が着手を指示した時刻（人が打つ）
skipGates: []           # 人が事前に見ないと宣言したゲート（plan）
change: null            # openspec の change 名
branch: null
mr: null                # GitLab MR iid（branch から自動解決して書き戻す）
---
```

本文の見出しにも意味がある。`## レビュー` は人の判断を残す追記専用ログで、
ステージ導出の入力になる。`## 探索メモ` は自由記述であり、導出には効かない。

`id` が不変で `change` / `branch` / `mr` が進行に応じて後から埋まることで、
アイデアメモ → change → ブランチ → MR → archive が 1 本の線につながる。
カードはエディタで直接編集してよく、ファイル監視 → SSE 経由でブラウザへ即座に反映される。

## 書き込み境界

「誰の書き込みか」で分かれる。混同しないこと。

| 主体                | `openspec/`                              | `.ai-board/`                     |
| ------------------- | ---------------------------------------- | -------------------------------- |
| ai-board サーバ     | **read-only**（openspec CLI の領分を侵さない） | 書く（カードファイルの唯一の書き手） |
| AI エージェント     | 書く（`/opsx:*` で change を起票・実装・archive） | カードの本文・リンク欄のみ         |

エージェントが**やってはいけないこと**（`.ai-board/cards/board-loop-skill.md` のハードルール）:

- `startedAt` を自分で打たない。これは人が着手を指示する合図。
- `## レビュー` に書いてよいのは 提出 / 再提出 だけ。承認 / 否決 / 中止 は人が書く。
- `skipGates` を自分で足さない。
- 計画レビュー / PR中 のカードのステージに触らない。
- 品質ゲートを通らないままコミットしない。

ステージを直接指定する入力口は存在しない。列を動かしたければ、その列を成立させる実態
（`startedAt` の打刻、`proposal.md` の作成、`## レビュー` への承認追記）を作る。

## ステージ導出

核は `src/board/services/stage-resolver.ts` の純関数。
7 段の判定表と各ルールの理由はそのファイルの docstring にある（README にも同じ表がある）。
**変更するならまずここを読む。** ルールは制御構造ではなく `RULES` 配列の順序で表現され、
「上から評価して最初に真になったものが勝つ（＝最も進んだステージ）」を意味する。

ゲートの状態は `src/cards/services/review-log.ts` が本文の `## レビュー` から読む。
ゲートは `plan` の 1 つだけで、廃止した `explore` のエントリは規定外として黙って無視される。
`gateState()` はゲートごとの最新エントリ 1 件で決まり、中止のエントリは判定から除く
（中止は工程の進捗と直交する終端の軸で、通過済みのゲートを巻き戻さない）。

守るべきは列の所有権の分割。

| 列                        | ステージを立てるもの                       | 領分 |
| ------------------------- | ------------------------------------------ | ---- |
| アイデア / 計画提案中     | `startedAt` の打刻                         | 人   |
| 計画レビュー              | `proposal.md` の存在                       | AI   |
| 実装中 / 検証中           | `## レビュー` の plan 承認 と tasks の進捗 | 人 → AI |
| PR中                      | GitLab の MR 状態                          | AI   |
| マージ済み                | archive / merged                           | AI   |

UI のドラッグは `startedAt` を書き換える 1 遷移だけ。承認 / 否決 / 中止はボタンで
`POST /api/cards/:id/reviews` を呼び、本文への追記になる。
「`startedAt` を外したときに残るステージ」（AI の成果物とレビュー記録が課す下限）より
前へは戻せない（`resolveFloorStage` / `droppableStages`）。

否決の差し戻しに専用ルールは無い。ゲートが差し戻し中のときレビュー行と承認行が両方外れ、
1 つ手前の AI 列へ自然に落ちる。**ここに `if` を足したくなったら設計を疑う。**

`openspec/` は CLI をサブプロセス起動せずディレクトリを直接読む
（`src/board/repositories/openspec.repository.ts`）。archive の日付プレフィックスや
tasks の行パターンは `@fission-ai/openspec` **v1.12.0** の実装から移植したもので、
参照元の定数名がコメントに残っている（行番号は腐るので書かない）。
**openspec を上げたときは参照先の定数を突き合わせる。**

既知の未追従: change 名自体が `YYYY-MM-DD-` で始まる場合、1.12.0 は接頭辞を重ねず
既存名のまま archive する（#1309）ため、日付を剥がす前提の完了判定が外れる。

## レイヤー構成と規約

```
src/
  app.ts                Express アプリケーションファクトリ
  server.ts / cli.ts    起動（cli.ts は引数解析とブラウザ起動）
  shared/               Result<T,E>・Branded Types・設定・ミドルウェア
  cards/                カードの CRUD コンテキスト
  board/                3ソース統合・ステージ導出コンテキスト
  infrastructure/       ファイル監視・SSE・GitLab ポーリング
  web/                  React + Vite のカンバン UI
```

各コンテキストは `models/ errors/ repositories/ usecases/ controllers/ composition.ts` を持つ。

- **usecase は例外を投げず `Result<T, E>` を返す**（`src/shared/result.ts`）。
- **エラーは discriminated union**（`{ type: 'CardNotFound', id }`）で表し、
  controller が `*-error-mappings.ts` の `switch` で HTTP ステータスへ変換する。
  エラー種を増やしたらマッピングの `switch` も網羅する（型が漏れを検出する）。
- **依存はコンテキストごとの `composition.ts`（Composition Root）で構成する。**
  usecase やリポジトリの中で `new` して依存を作らない。
- **ID は Branded Type**（`CardId` / `ChangeName` / `MergeRequestIid`）。
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

## GitLab 連携

`.ai-board/config.yaml` の `gitlab.url` / `gitlab.projectId` と、環境変数
`AI_BOARD_GITLAB_TOKEN` の**両方**が揃ったときだけ有効になる。
欠けていれば連携は無効になり `ai-pr` 系の列が空になるだけでボードは動く。
**トークンは設定ファイルに書かず、ブラウザにも返さない。**

検証用 GitLab は `docker compose up -d`（`http://localhost:8929`、`.env` に `GITLAB_ROOT_PASSWORD`）。
ポート 8080 は omnibus 内部の puma と衝突して静かに 502 になるため使えない。
`external_url` は実際にブラウザで開く URL と一致させる（ずれると API は 200 のままリンクだけ壊れる）。
詳細と疎通確認の手順は README の「ローカル GitLab」節にある。

MR 一覧の全件取得はページングで取りこぼすため使わず、カード単位で問い合わせる。

## API

| メソッド | パス                  | 用途                                       |
| -------- | --------------------- | ------------------------------------------ |
| `GET`    | `/api/board`          | 全カード＋導出ステージ＋openspec / GitLab 情報 |
| `POST`   | `/api/cards`          | 新規アイデアカード作成                     |
| `PATCH`  | `/api/cards/:id`      | frontmatter の部分更新                     |
| `PUT`    | `/api/cards/:id/body` | 本文の差し替え                             |
| `POST`   | `/api/cards/:id/reviews` | `## レビュー` へのエントリ追記（承認 / 否決 / 中止） |
| `GET`    | `/api/events`         | SSE。ファイル変更・ポーリング結果を push   |

## OpenSpec ワークフロー

change は `/opsx:explore` → `/opsx:propose` → `/opsx:apply` → `/opsx:archive` で回す
（スキルは `.claude/skills/openspec-*/`）。
成果物は日本語で書き、OpenSpec の構造見出しと SHALL / MUST キーワードは英語のまま残す
（`openspec/config.yaml` の `context`）。

## コミット

日本語の Conventional Commits。

```
feat: ローカル GitLab を compose で立ててボードから疎通させる
chore: 未着手カードの startedAt を null に戻す
docs: ローカル GitLab 疎通の change を起票する
```
