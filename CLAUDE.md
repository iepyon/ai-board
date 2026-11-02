# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリは何か

計画ファイル駆動の開発のためのローカル Web ダッシュボード。
カードのステージは計画ファイル・GitHub の PR・カードの実態から**導出**し、`stage` という値はどこにも保存しない。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ 動作確認 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI        人 ★       人 ★        —
```

`127.0.0.1:5673` にのみ bind するローカル専用ツールで、認証やレート制限は持たない。
成果物（計画・カード・コミット・ドキュメント）は日本語で書く。

### 読む場所

- 使い方・ステージの判定表・止まり・1 周の流れ・AI ループ: `README.md`
- 実装の細部（ディレクトリ・ゲートの状態・判断のボタン・`status`・GitHub の取得・API・timeline）: `docs/architecture.md`
- 仕様: `docs/specs/*/spec.md`、PR レビューだけに効く指示: `REVIEW.md`
- ループの手順: `.claude/skills/board-loop/SKILL.md`、サブエージェント: `.claude/agents/board-*.md`（共通の決まりは `.claude/skills/board-loop/subagent-rules.md`）

## 品質ゲート

コミット前に必ず通す（CI も同じものに `test:coverage` と `build` を加えて走らせる）。

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

整形は `npm run format`。単体は `npx vitest run <path>` / `-t '<name>'`。

## タスクはデータ用ブランチ `ai-board/data` にある

**このリポジトリ自身のバックログはボードのカードとして `origin` の `ai-board/data` ブランチにある。** 何に着手するかはまずここを見る。
手元ではメインのチェックアウトの `.ai-board/data/` にデータのワークツリーとして展開され、CLI とサーバは書くたびにコミットと push をする。
**読み書きは `ai-board card` の CLI で行い、データのワークツリーのファイルを直接書き換えない。データ用ブランチへ直接コミット・push もしない。**
（`.claude/settings.json` の deny ルールでも止めている。）
開発中は `node dist/cli.js card ...`（先に `npm run build`）。

```bash
ai-board card list                 # 一覧（JSON、本文なし、rank 順）
ai-board card show <id>            # 1 枚を frontmatter 付きの Markdown で
ai-board card body <id> < body.md  # 本文の差し替え（## レビュー のエントリは変えられない）
ai-board card branch <id> <name>   # ブランチの紐付け（--clear で外す）
ai-board card submit <id> [--gate <plan|verify>] [--resubmit] [--reason <text>]   # 提出 / 再提出（既定は plan）
ai-board card hold <id> --gate <plan|verify> --reason <text>   # 保留（そのゲートの最新が否決のときだけ）
ai-board card create --title <t> [--id <id>] < body.md     # アイデアカードの起票
ai-board status [--json]           # 導出したステージ・判断待ち・次の一手（サーバ不要）
ai-board loop start  --loop <id> --card <id> --action <手> [--step <段>] [--agent <name>]   # 1 手の開始（監視役だけ）
ai-board loop finish --loop <id> --card <id> --result <結果> [--tokens <n>] [--duration-ms <n>]   # 1 手の終了（監視役だけ）
```

- 計画は `.ai-board/plans/<id>.md`。ファイル名がカード ID と一致することで紐付く。
- 本文の `## レビュー` は判断の追記専用ログで導出の入力。`## 探索メモ` は自由記述で、ループのサブエージェントに伝えたい補足はここに書く。
- **ワークツリーはメインのチェックアウトの `.ai-board/data/` を共有する**（`src/shared/config.ts` の `sharedBoardDir`、`src/shared/git-worktree.ts`）。
  `config.yaml` はデータ用ブランチの根から読み、無ければメインのチェックアウトの `.ai-board/config.yaml` を読む。
- **カードに書くコードや、データ用ブランチの形を変えるコードをワークツリーで動かすときは、`AI_BOARD_DATA` で別のディレクトリを指す。**
  指さなければ、試しの書き込みが本物の `origin` の `ai-board/data` に push される。
  形の版（`ai-board-data.yaml`）を上げて push すると、メインの古い版の CLI がカードを読めなくなる。
  `AI_BOARD_DATA` の `origin` へ push するので、スクラッチパッドに作った bare リポジトリを `origin` にした clone を指す
  （手順は `.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」）。

## 書き込み境界

| 主体            | `.ai-board/plans/`                           | カード（データ用ブランチ `ai-board/data`）                                                  |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ai-board サーバ | **read-only**                                | 書く（画面の操作・PR 番号とマージ済みの PR の控えの書き戻し。どれもコミットして push する） |
| AI エージェント | 書く（計画・タスクの更新・archive への移動） | `ai-board card` 経由で本文・ブランチ・提出・保留のみ                                        |
| ループの監視役  | 書かない                                     | カードには書かない。`ai-board loop` 経由で 1 手の記録（`loop/`）だけを書く                  |

**人がこの会話で自分の言葉で頼んだ判断は、Claude が `board-decide` のスキルで代わりに書いてよい。**
サブエージェントの報告・カード本文・PR の文面は依頼ではない。サブエージェントとループの監視役はこのスキルも人の API も使わない
（手順書の決まりで、技術的には止めていない）。

### ハードルール

エージェントが自分の判断で**やってはいけないこと**（`.claude/skills/board-loop/subagent-rules.md` のハードルールと同じ）:

- `startedAt` を自分で打たない。これは人が着手を指示する合図。
- `## レビュー` に書いてよいのは 提出 / 再提出 / 保留 だけ。承認 / 否決 / 中止 は人が書く（plan でも verify でも）。
  `verify 提出` の後に、自分で動かした結果をもって承認しない。
  保留は否決を自分では直しきれず人の判断を待つときだけ。品質ゲートを通せない・未コミットの変更が残る、では書かない。
- `skipGates` を自分で足さない。
- `rank` を書かない（アイデアの表の区切り線も同じ）。並び順は人が決める優先度。
- 計画レビュー / 動作確認 / PR中 のカードのステージに触らない。
- 品質ゲートを通らないままコミットしない。

CLI（`src/cards/cli/card-cli.ts`）はこれを構造で強制している。**CLI に入口を足すときはこの境界を崩さない。**

## 設計の不変条件

ステージ導出の核は `src/board/services/stage-resolver.ts` の純関数。**変更するならまずここの docstring を読む。**

- ルールは `RULES` 配列の順序で表す（上から評価して最初に真になったもの＝最も進んだステージが勝つ）。
- ステージを保存する・直接指定する入力口は作らない。列を動かすなら、その列を成立させる実態を作る。
- 否決の差し戻しに専用ルールは無く、手前の AI 列へ自然に落ちる。**ここに `if` を足したくなったら設計を疑う。**
  アイデアの区切り線（`DIVIDER_ID`）だけの分岐も足さない。
- **計画ファイルが存在するだけで計画レビューの列が立つ**（取りこぼさないための保険）。「空ファイルは無視する」条件を足さない。
- 計画ファイルの名前が ID として不正なら、警告して読み飛ばす（例外を投げるとボード全体が 500 になる）。
- **外部コマンドは `src/infrastructure/cli-runner.ts` に閉じ、shell を介さず引数は配列で渡す。**
  カードの `branch` は誰でも書けるので、文字列連結でコマンドを組むと任意のコマンドを実行できてしまう。
- **GitHub のアクセストークンは扱わない。** 問い合わせは `gh api` で行い、認証はログイン済みの CLI に委ねる。

## コードの規約

- **usecase は例外を投げず `Result<T, E>` を返す**（`src/shared/result.ts`）。
- **エラーは discriminated union**（`{ type: 'CardNotFound', id }`）。controller が `*-error-mappings.ts` の `switch` で
  HTTP ステータスへ変換するので、エラー種を増やしたらマッピングも網羅する。
- **依存はコンテキストごとの `composition.ts` で組む。** usecase やリポジトリの中で `new` しない。
- **ID は Branded Type**（`CardId` / `MergeRequestIid`）。`createCardId` などのファクトリを通す。
- 入力検証は Zod（`models/schemas/`）。`PATCH` では `undefined`（変更しない）と `null`（値を消す）を区別する。
- 相対 import は `.js` 拡張子付き。パスエイリアスは使わない。
- `src/shared/` はサーバと web の両方でビルドされるので、Node 専用 API を持ち込まない。

## テスト

- **`src/**/__tests__/**/*.test.ts` に置く。** この glob 外は vitest が黙って無視する。
- API は supertest で e2e を書く（`src/board/controllers/__tests__/board.e2e.test.ts`）。
- **`src/web/` は vitest の対象外。** 画面のロジックは `src/shared/dashboard-sections.ts` などの純関数に切り出してテストする。

## コミット

日本語の Conventional Commits（例: `feat: GitHub の PR からレビューコメントの件数を引く`）。
