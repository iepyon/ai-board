# ai-board

計画ファイル駆動の開発のためのボード。`ai-board` の CLI とチャット（Claude Code のスキル）で扱う。

カード・`.ai-board/plans/` の計画・GitHub の PR を読んで、各カードのステージを導出する。`stage` という値はどこにも保存しない。
人の判断（着手・承認・差し戻し・中止）もカード上の痕跡として残り、導出の入力になる。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI        人 ★        —
```

★ が人の判断を待つゲート。計画レビューでは計画を読む。PR中 では AI が PR の本文に書いた動作確認の結果を読み、必要ならブランチを動かし、差分を読んでマージする。
人が動かすのは `アイデア ⇄ 計画提案中`（着手）だけで、あとは AI が右へ進め、★ で止まる。
AI エージェントと開発を回すと実態がカード・計画・PR に散らばるので、それを 1 本のパイプラインとして「いま誰の番か」を見せる。

実装の細部は各モジュールの docstring、設計判断の理由は [`docs/adr/`](docs/adr/)、仕様は `docs/specs/` にある。

## 使い方

Node 24 以上が要る（CI は 26 で走らせている）。

```bash
npm install
npm run build
node dist/cli.js status --root /path/to/your-project   # .ai-board/ を持つプロジェクトのルート
```

サブコマンドは `card`（カードの読み書き）・`status`・`init`・`pr`（`gh api` の REST での PR の読み書き）・`decide`（人の判断）・`loop`（ループの 1 手の記録）・`dist-check`（`dist/` が HEAD より古ければ 1）。
細部は `ai-board --help` と `ai-board <command> --help` で見る。常駐するサーバは無い（[ADR 0017](docs/adr/0017-remove-web-and-server.md)）。

## ボードの見方

`ai-board status` は人向けの数行を、`status --json [--active] [--only <項目,...>]` はループや手順書が読む JSON を出す。
人向けの形は「GitHub:」「ループ:」の行・判断待ち・AI 作業中・次の一手を出し、JSON はそれに全カード（`cards`）とアイデアの表（`ideas`）を足す。
`--active` を付けると、`cards` からマージ済みと中止のカードを外す。
チャットで「ボードを見せて」と頼むと、`board-view` のスキルが判断待ち・AI 作業中・アイデアを 1 枚のページにして Artifact で公開する（中身は `status --json --active`。頼んだ時点の写し）。

- **判断待ち（`waiting`）:** 計画レビュー / PR中 と、止まっているカード。待ち始めの古い順で、止まった理由と出せる判断（`decisions`）が付く
- **AI 作業中（`working`）:** 計画提案中 / 実装中（止まっているものを除く）と、人の指摘に AI が応える番の PR中（先頭）。`rank` の順。
  計画ファイル（計画が無ければ着手）から 3 日動きが無いと「動きなし」になる
- 「ループ:」の行は「<カード> を <手> 中（12 分）」「最後の手から 40 分」「記録なし」のどれか

## ステージの決まり方

上から評価し、最初に真になったもの（＝最も進んだステージ）を採る。手動で上書きする仕組みは無い（`src/board/services/stage-resolver.ts`）。

| #   | stage         | 条件                                                                 |
| --- | ------------- | -------------------------------------------------------------------- |
| 1   | `merged`      | 計画が `.ai-board/plans/archive/` にある、**または** PR が merged    |
| 2   | `pr`          | PR が存在し opened、かつ Draft でない                                |
| 3   | `impling`     | plan ゲート通過済み                                                  |
| 4   | `plan-review` | `.ai-board/plans/<id>.md` か Draft の PR があり、plan ゲートが未判断 |
| 5   | `planning`    | `startedAt` が非 null                                                |
| 6   | `idea`        | 既定                                                                 |

計画と実装は 1 本の PR に載る。AI は計画をコミットした時点で Draft の PR を出し、人はそれを読んで承認か差し戻しをする。
実装と AI レビューを終えた AI は、CI が通るのを確かめ、動かした手順と結果を PR の本文の `## 動作確認の結果` に書き、計画を archive して Ready にする。
実装中の PR も Draft だが、plan が承認済みなので 3 で決まり、計画レビューへは巻き戻らない。
**差し戻しに専用のルールは無い。** ゲートが差し戻し中ならレビュー行と承認行が両方外れ、手前の列へ自然に落ちる。

### レビューログ

人の判断はカード本文の `## レビュー` に追記される。ゲートは `plan` の 1 つで、種別は 提出 / 再提出 / 保留（AI が書く）と 承認 / 差し戻し / 中止（人が書く）。

```markdown
## レビュー

### 2026-09-11T04:00:00.000Z plan 提出

### 2026-09-11T05:12:00.000Z plan 差し戻し

既存の stage-resolver を見ていない。導出ルールとの整合を調べ直して。

### 2026-09-11T09:30:00.000Z plan 再提出
```

ゲートの状態はそのゲートの最新エントリ 1 件で決まる。中止はゲートの判定から除く（通過済みのゲートを巻き戻さない）。
PR の承認とマージは GitHub の実態そのものなので、PR のゲートはログを持たない。

### 止まり

AI の列にいても人の判断を待っているカードを**止まり**と呼ぶ。ステージとは別の軸の派生値で、判断待ちに出て、ループは選ばない。

| 止まり                                                      | 列                               | 人がすること                                                        |
| ----------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| 人の判断の後に、PR が Draft に戻された                      | 実装中                           | GitHub で Ready に戻す / 計画から立て直させる / 中止                |
| GitHub が未設定のボードで、締めの段が終わった（マージ待ち） | 実装中                           | メインで `git merge --no-ff <branch>` / 計画から立て直させる / 中止 |
| AI が `plan 保留` を書いた                                  | 計画提案中                       | 計画を直させる / 中止                                               |
| 計画を提出したのに計画ファイルも Draft の PR も見えない     | 計画提案中                       | 中止                                                                |
| そのカードの PR の状態だけを GitHub から引けない            | アイデア・マージ済み以外のどれも | 時間を置く。続くなら GitHub で PR を確かめる                        |

人が承認 / 差し戻し / 中止を書けばそれが最新になって外れる（引けない止まりは、引ければ外れる）。解く専用の操作は無い。

### 出せる判断

| カード                                       | 出せる判断                  |
| -------------------------------------------- | --------------------------- |
| アイデア                                     | 中止                        |
| 計画レビュー                                 | 承認 / 差し戻す / 中止      |
| 実装中で止まっている（Draft へ戻された）     | 計画から立て直させる / 中止 |
| 計画提案中で止まっている（plan 保留）        | 計画を直させる / 中止       |
| 計画提案中で止まっている（成果物が見えない） | 中止                        |
| PR の状態を引けない                          | 出さない                    |

「差し戻す」「計画から立て直させる」「計画を直させる」はどれも理由の要る plan の差し戻し。
PR中 は GitHub でマージして判断する。小さな指摘は PR にコメントを書けば、ループが `fix-pr` の手で Ready のまま修正を push するか、
直すものが無い理由を 1 件返信して人の番に戻す（[ADR 0016](docs/adr/0016-pr-feedback-ai-turn.md)）。計画から作り直させるなら、PR を Draft に戻して「計画から立て直させる」。

### スキップ

frontmatter の `skipGates` に `plan` を入れると、AI の 提出 / 再提出 を人の承認と同じに読む。小さいカードを人のいない間に流すときに使う。
差し戻し / 保留 / 承認 はふつうに効き、着手するまではアイデアに留まる。入れるのは人だけ（`ai-board decide skip`）。

## カード

カードの正本は `origin` の `ai-board/data` ブランチ（コードの履歴と交わらない orphan のブランチ）にあり、`cards/<id>/` が 1 カード。
CLI はメインのチェックアウトの `.ai-board/data/` にワークツリーとして展開し、書くたびに「取り直す → 検査する → コミットする → push する」を 1 操作で行う（push が拒否されたら頭からやり直す）。
リンクされたワークツリーから動かしても、このデータのワークツリーを共有する。`ai-board card show <id>` は次の形で出す。

```markdown
---
id: refresh-token # 不変
title: リフレッシュトークン対応
created: 2026-09-01T09:00:00.000Z
startedAt: '2026-09-01T10:00:00.000Z' # 人が着手を指示した時刻
skipGates: [] # 人が事前に見ないと宣言したゲート（plan）
branch: feat/refresh-token
pr: 42 # GitHub の PR 番号（branch から解決して書き戻す）
rank: 1500 # 並び順。小さいほど上。並べ替えたときだけ書かれる
---

## アイデア

## レビュー
```

エージェントは `ai-board card`（本文・ブランチ・提出・保留だけ。コマンドは `CLAUDE.md`）で、人は `ai-board decide` で書く。データのワークツリーのファイルを直接書き換えない。

### 人の判断

チャットで「〜の計画を承認して」「差し戻して、理由は〜」「〜を一番上へ」「判断待ちを見せて」と頼むと、`board-decide` のスキルが `ai-board decide` で代わりに書く。

```bash
ai-board decide approve <id> [--reason <text>]     # plan を承認する
ai-board decide reject <id> --reason <text>        # plan を差し戻す
ai-board decide abort <id> [--reason <text>]       # 中止する
ai-board decide start <id> / unstart <id>          # 着手する / 着手を戻す（計画レビュー以降は戻せない）
ai-board decide skip <id> --gate plan [--remove]   # 計画レビューを飛ばす宣言を入れる / 外す
ai-board decide move <id> --after <ref> --before <ref>      # アイデアの並べ替え（<ref> はカード ID・:divider・none）
ai-board decide move-divider --after <ref> --before <ref>   # 区切り線を動かす
```

書く前にボードを導出し、出せない判断は拒む。GitHub に繋がらないときは判断と着手を拒む（宣言と並べ替えは書く）。`config.yaml` に `github:` が無い（未設定）ボードは PR が無いので拒まない（PR 番号の残ったカードだけは止まりになる）。
誰が呼んでも書けるので、守りは「人がこの会話で頼んだときだけ使う」という手順書の決まりにある（[ADR 0007](docs/adr/0007-board-decide.md)）。
書いた判断で AI の番ができたら、同じセッションで `board-loop` の 1 周が続く（[ADR 0013](docs/adr/0013-continue-loop-after-decide.md)）。

アイデアの表は上ほど優先度が高く、区切り線より上が「次にやる」、下が「あとで考える」。新しいカードは末尾に付く。

## 計画ファイル

`.ai-board/plans/<card-id>.md` がそのカードの計画で、**ファイル名がカード ID と一致することで紐付く。** 書くのは AI で、CLI は read-only に扱う。

```markdown
# リフレッシュトークン対応

## 方針

## 動作確認の手順

1. `npm run build` の後、トークンの期限を切らした状態で API を呼ぶ
2. 応答が 200 になり、保存したトークンが入れ替わっていることを見る

## タスク

- [x] トークンの保存先を決める
- [ ] 更新エンドポイントを足す
```

チェックボックスはタスクの進み（`plan.tasks`）になるが、**ステージは立てない。** コードブロックの中のチェックボックスは数えない。
**計画ファイルが存在するだけで計画レビューの列が立つ**（人待ちを取りこぼさないための保険）。
`config.yaml` に `github:` が無い（未設定）ボードでは、Draft の PR の代わりにカードのブランチの計画を読んで計画レビューを立てる。ループの計画の手は push と PR を飛ばすので、人は `git show <branch>:.ai-board/plans/<id>.md` で計画を読む。
承認の後も、実装の手と AI レビューは push と PR を飛ばしてブランチにコミットするだけで進む。締めの段は CI を確かめず、動作確認の結果などを PR の本文の代わりに計画の末尾に書いて archive する。
締めの後のカードは 実装中 のままマージ待ちの止まりとして判断待ちに出る。人がメインのチェックアウト（`main`）で次を打つとマージ済みになる（AI はマージしない）。

```bash
git show <branch>:.ai-board/plans/archive/<id>.md   # 動作確認の結果を読む
git diff main...<branch>                             # 差分を読む
git merge --no-ff <branch>                           # マージする
```

締めの段の AI は `## 動作確認の手順` をもとに動かし、「確かめたこと / コマンド / 結果」の表を PR の本文に書く。
`ai-board pr checks <n> --wait` で CI を確かめ（赤なら 2 回まで直す）、同じ PR の中で計画を `plans/archive/` へ移して Ready にする。マージで archive も main に入る。

## AI ループ

`board-loop` のスキル（`.claude/skills/board-loop/SKILL.md`）は、`ai-board status --json` の `next` が示すカードの次の 1 手を、動かしたセッションが自分で進める。
優先は PR中（指摘に応える番のもの）→ 実装中 → 計画提案中、同じ列は `rank` の順。`/loop 5m /board-loop` で間隔運転する。

| 手            | 選ばれるとき                     | すること                                                                          |
| ------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `plan`        | 計画提案中で、計画がまだ無い     | 計画を書いて Draft の PR を出し、`plan 提出` を書く                               |
| `revise-plan` | 計画提案中で、計画が差し戻された | 計画を直して `plan 再提出`。直しきれなければ `plan 保留`                          |
| `implement`   | 実装中で、止まっていない         | `next.step` の段を進める（下の表）                                                |
| `fix-pr`      | PR中 で、人の指摘に応える番      | Ready のまま修正を push するか、直すものが無い理由を `ai-board pr comment` で返信 |

| 計画の状態                             | `next.step` | すること                                                                      |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| 未チェックのタスクがある               | `task`      | 残りの節を上から倒し、節ごとにコミットする                                    |
| 全部倒れていて `## AI レビュー` が無い | `review`    | `board-reviewer` のサブエージェントが指摘を計画の末尾に書く。コードは直さない |
| `## AI レビュー` がある / archive 済み | `close`     | 動かして確かめ、PR の本文に結果を書き、計画を archive して Ready にする       |
| 読めなかった                           | `null`      | ワークツリーで計画を読んで判断する。レビューの段なら止まる                    |

- 実装を書いたセッションが自分の差分を審査しないよう、AI レビューだけを別の文脈に切り分ける（[ADR 0011](docs/adr/0011-loop-single-session.md)）
- 止まっているカード・計画レビューのカードには触らない。GitHub に接続できないときは何もせずに止まる（`github:` が無い未設定のボードは止まらず、push と PR を飛ばし、締めの後のマージ待ちまで進む）
- 手を終えたら同じ手番で次の手へ進み、`止まった`・失敗・`next` が null で終える。同じ手で止まり続けるカードには `止まった ×N` の印が付く
- 1 手ごとに `ai-board loop start` / `finish` でデータ用ブランチの `loop/` に記録を残す。記録は表示にだけ使う（[ADR 0014](docs/adr/0014-loop-step-record.md)）

### ループの許可ルール

ループは auto モードで回す前提で、`.claude/settings.json` には分類器に任せると困るものだけを書く（[ADR 0012](docs/adr/0012-loop-permissions.md)）。

- **`allow`:** `main` 以外への `git push --force-with-lease origin <branch>`、カードのワークツリーの中の取り消し（`checkout -- .` / `clean -fd`）
- **`ask`:** `git reset --hard`、`git branch -D` / `-d`、`git worktree remove`、`ai-board init`
- **`deny`:** データのワークツリーの編集とデータ用ブランチへの push、`main` への push、`--force` / `-f` / `+` の force push、`--mirror` の push、
  メインのチェックアウトの `.claude/settings*.json` の編集

許可ルールは前方一致で迂回できる**事故よけの保険で、境界そのものではない。** 境界は `ai-board card` の構造と手順書の決まりに置く。
`main` にはブランチ保護（直接の push と force push の禁止）を入れることを勧める。

### クラウドのセッション・Windows

- クラウド: clone した時点でカードが見える。まず `npm ci && npm run build` で `dist/` を作り、会話で `/loop 5m /board-loop` を回し、判断は会話で頼む。
  GraphQL が 403 になる（`gh pr` が動かない）ので、手順書は `ai-board pr ...` を使う。ブランチを消せないので「Automatically delete head branches」を有効にしておく
- Windows: Git Bash で回せる（PowerShell / cmd は想定しない）。`jq` の代わりに `status --json --only` を使い、改行は `.gitattributes` で LF に揃える。テストは Windows を対象にしていない

### オフラインの研修（手元モード）

GitHub に届かない環境で研修するときは、メインのチェックアウトの `.ai-board/data-mode.yaml` に 1 行書いて手元モードにする（git に載らない）。

```bash
echo 'mode: local' > .ai-board/data-mode.yaml
```

手元モードでは、カード・判断・ループの記録を fetch も push もせず、手元のデータ用ブランチへのコミットだけで書く。
オンラインで回すときはファイルを消す（または `mode: sync` にする）。今どおり書くたびに fetch と push をする。
fork と clone、`ai-board init` は GitHub に届くうちに済ませておく（`init` は手元モードの対象外）。

既定のモードに戻したとき、手元モードで書いたコミットが `origin` に無ければ、CLI は消さずに止まり、次のどれかを選ぶよう案内する。

- 上げる: `git -C .ai-board/data push origin HEAD:ai-board/data`
- 捨てる: `git -C .ai-board/data reset --hard origin/ai-board/data`
- 手元モードで続ける: `data-mode.yaml` に `mode: local` を書き戻す

### 始め方

新しいリポジトリでは、`.ai-board/config.yaml` を用意してから、メインのチェックアウトで `node dist/cli.js init` を走らせる。
空のデータ用ブランチを作って push し、`config.yaml` をその根へ写す。ほかの clone では最初に CLI を動かしたときにワークツリーが作られる。

## GitHub との接続

```bash
cp .ai-board/config.example.yaml .ai-board/config.yaml   # github: { repository: owner/repo }
```

設定はデータ用ブランチの根の `config.yaml`、無ければ `.ai-board/config.yaml` から読む。
アクセストークンは受け取らず、問い合わせは `gh api` で行う（認証は `gh auth login` に委ねる）。
使えないときは連携が無効になり、理由が `status` の「GitHub:」の行に出る。使えないあいだも、マージ済みの PR はデータ用ブランチの手元の控えで出る（リンクと Ready・マージの時刻、区間の時間）。マージ前の PR は出さず、次の一手と判断も止まる。問い合わせるのは `branch` か `pr` のあるカードだけで、中止のカードの PR は一度控えを取った後は引き直さない。

## 開発

```bash
npm run typecheck && npm run lint && npm run format:check && npm test   # 品質ゲート（整形は npm run format）
npm run test:coverage   # 閾値は lines / functions / statements 80%、branches 75%
npm run build
```

CI（`.github/workflows/ci.yml`）は Actions の画面から手で起動したときだけ走る。PR のレビューだけに効く指示は `REVIEW.md` にある。

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
