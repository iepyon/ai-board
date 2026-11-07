# 中止のカードの PR を引き直さず、status --json から終わったカードを外せるようにする

## 人に判断してほしいこと

- **控えの無い中止のカードを、一度は GitHub に引くか。** マージされていない PR の控えは、git に載らない `cache/pr-snapshots.json` にあり、クラウドのセッションは毎回まっさらな clone から始まるので、控えが無い状態から始まる。既定: 控えが無ければ今どおり一度引いて控えに残し、2 回目から引かない（引かないと、そのカードの `prState` が null になり、PR のリンクが消える）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **絞り込みの指定の名前と形。** 既定: `--active` の 1 つだけを足し、`cards` から マージ済み と 中止 の区画のカードを外す。区画を選べる `--section inbox,work,idea` は作らない（`### 退けた代案`。人に判断してほしいこと）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **`status --json` の既定。** 既定: 全件のまま。`--active` を付けたときだけ絞る（既定で絞る案は `### 退けた代案`。人に判断してほしいこと）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **`board-decide` の手順 1 の読み出しに `--active` を付けるか。** 既定: 付ける。判断を書けるのは中止でもマージ済みでもないカードだけなので、終わったカードの `prState` を読む必要が無い
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **`ai-board card list` に中止を外す指定を足すか（C-3）。** 2026-11-07 のチャットで見送ると決めた。既定: 足さない（`### Non-Goals`。人に判断してほしいこと）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）

承認は、回答の無い項目をすべて既定のまま進めると読む。既定と違う答えは、plan 承認の理由ではなく plan 差し戻しの理由で返してほしい。

## 提案

### Why

データの持ち方（1 カード 1 ディレクトリ、ステージは保存せず導出）は、カード 90 枚の読み込みが約 12ms で、問題になっていない（2026-11-07 に測った）。
問題は、終わったカードのぶんの GitHub への問い合わせと、AI が読む `status --json` の量である。

- `status` 1 回の GitHub への問い合わせは 3 回で、そのうち 2 回は中止の `loop-dummy` / `loop-worker-dummy` の、マージされずに閉じた PR（#29 / #36）だった。
  `PrFetcher.refresh` は PR 番号かブランチを持つ全カードを対象にし（`src/infrastructure/pr-fetcher.ts:86`）、マージ済みは控えで飛ばす（`isSettled`）が、閉じた PR は reopen されうるので毎回引く。
  中止のカードは、どのステージでも区画が 中止 に固定され（`board-sections.ts` の `sectionOf`）、判断も作業も待っていないので、PR を引き直しても何にも効かない
- `status --json` は約 233KB で、`cards` の 98% はマージ済み（54 枚）と中止（30 枚）のカードである。`--only` は項目を絞れるがカードは絞れない。
  `board-decide` が手順 1 で読む `--only waiting,ideas,cards.id,cards.title,cards.stage,cards.skipGates,cards.latestReview,cards.prState` は約 69KB で、大半はマージ済みのカードの `prState` である

### What Changes

- `ai-board status` は、中止のカードの PR を、控えがあれば GitHub に引き直さない。控えは消さずにそのまま使う（`cards[].prState` は今までどおり出る）
- `ai-board status --json --active` で、`cards` から マージ済み と 中止 の区画のカードを外して出す。`--only` と組み合わせられる。`--active` は `--json` と一緒にだけ使える（`--only` と同じ）
- `next` / `waiting` / `working` / `ideas` / `forge` / `loop` は `--active` でも変わらない（今も生きているカードしか持たない）
- `board-decide` の手順 1 の読み出しに `--active` を付ける
- 人向けの `status` の出力、ステージ、次の一手、出せる判断は変わらない

### Impact

- 問い合わせ: `src/board/services/pr-state-provider.ts`（中止のカードの控えを決まったとみなす純関数を足す）、`src/infrastructure/pr-fetcher.ts`（`refreshCard` がそれを見て引き直さない）
- 区画: `src/board/services/board-sections.ts`（生きているカードかを返す純関数を足す）
- CLI: `src/board/cli/status-cli.ts`（`--active` の解釈・使い方・絞り込み）
- 手順書: `.claude/skills/board-decide/SKILL.md`（手順 1）
- ドキュメント: `docs/architecture.md`（`status` の出力・GitHub の PR の取得の控え）、`README.md`（`status` の使い方・GitHub との接続）
- ステージの導出（`stage-resolver.ts`）・控えの形・データ用ブランチの形の版（`ai-board-data.yaml`）・`ai-board card`・届かないときの供給元（`matchMergedSnapshots`）: 変わらない

## 設計

### Decisions

#### C-1. 中止のカードの PR を引き直さない

- `src/board/services/pr-state-provider.ts` に純関数 `isFrozen(card, snapshot)` を足す。
  `card` は `{ pr, body }` を受け、次をすべて満たすとき真を返す
  - `snapshot` が null でない
  - `card.pr === snapshot.pr.number`（ブランチや番号を付け替えた後の古い控えは使わない。`isSettled` と同じ照らし合わせ）
  - カード本文の `## レビュー` の最新が 中止（`isAborted(parseReviewLog(card.body))`）
- `PrFetcher.refreshCard` の先頭の `if (isSettled(card, previous)) return;` を、`isSettled` か `isFrozen` が真なら引き直さずに返す形にする
- 中止のカードは問い合わせの対象（`targets`）から外さない。外すと `forgetUntracked` が控えを消す。対象に残したまま `refreshCard` で飛ばすので、控えは残り、`get` で今までどおり返る
- 控えが無い中止のカードは、今どおり一度引いて控えに残す（人に判断してほしいこと）
- 中止の後に人が別の判断を書いて最新が 中止 でなくなれば、`isFrozen` が偽になり、次の `status` から今どおり引き直す。専用の扱いは足さない

#### C-2. `status --json --active`

- `src/board/services/board-sections.ts` に純関数 `isActiveCard(card: SectionCard): boolean` を足す。`sectionOf(card)` が `merged` でも `aborted` でもなければ真
  - 区画の決め方は `sectionOf` 1 つに残し、ステージの読み方を新しく作らない
- `src/board/cli/status-cli.ts`
  - `StatusArgs` の JSON の形に `active?: true` を足す。`scanStatusArgs` が `--active` を読む（2 回目は誤り）
  - `pickFormat` は、`--active` が `--json` 無しで付いたら誤り（`--only` と同じ）にする
  - `runStatusCli` は、`active` なら `report.cards` を `isActiveCard` で絞った報告を作り、その後で `--only`（`pickFields`）か全体の JSON を出す
  - `STATUS_USAGE` に `--active` の行を足す
- `.claude/skills/board-decide/SKILL.md` の手順 1 の `status --json` に `--active` を足す

### 仮定

- **中止は終端とみてよい。** 中止のカードは、どのステージでも区画が 中止 に固定され（`sectionOf` の先頭）、`next` にも `waiting` にも `working` にも出ない。PR が後で変わっても表示と判断は変わらない。根拠: `board-sections.ts`・`next-action.ts`・`decision-options.ts`
- **中止かはカードだけで決まる。** `isAborted` は `## レビュー` だけを読み、GitHub を引かずに分かる（`branch-plan-target.ts` も同じ判定で git を走らせる回数を抑えている）
- **`isFrozen` は控えの照らし合わせなので、`pr-state-provider.ts` の `isSettled` の隣に置く。** `board/services` から `cards/services/review-log.ts` を import するのは、`branch-plan-target.ts` と同じ向きで、境界を崩さない
- **届かないときの供給元（`matchMergedSnapshots`）は変えない。** 届かないときに使う控えはマージ済みだけ、という ADR と `docs/architecture.md` の決まり（PR #99）を崩さない。中止のカードの区画は PR の状態に依らないので、表示は変わらない
- **`--active` の絞り込みは CLI の出し方に置く。** `--only` の絞り込み（`pickFields`）と同じく、報告（`StatusReport`）の組み立ては変えず、出す直前に絞る。区画の判定だけを純関数にしてテストする
- **ADR は書かない。** ステージを保存しない不変条件にも、GitHub への問い合わせを `gh api` に委ねる決まり（ADR 0003）にも触らない。控えで問い合わせを省く話なので、`docs/architecture.md` の「控え」の箇条を直す

### 退けた代案

- **状態ごとのフォルダ（`cards/next/` など）に分ける:** ステージを保存しない不変条件を崩し、並べ替えのたびにファイルを動かすことになる（2026-11-07 のチャットで比べて退けた）
- **終わったカードを `cards/archive/` へ移す:** データ用ブランチの形の版を上げる割に、90 枚の読み込みは約 12ms で速さがほぼ変わらない（2026-11-07 のチャットで比べて退けた）
- **状態の索引ファイルを持つ:** 正本との食い違いを考えることになり、今の規模では要らない
- **中止のカードを問い合わせの対象（`targets`）から外す:** `forgetUntracked` が控えを消し、`prState` が null になる。対象に残して `refreshCard` で飛ばす
- **区画を選べる `--section inbox,work,idea`:** 今の読み手（`board-decide`）が要るのは「終わったカードを外す」だけで、指定の組み合わせを検査する分だけ CLI が大きくなる（人に判断してほしいこと）
- **`status --json` の既定で終わったカードを外す:** `cards` を全件読む読み手（今日のアイデアの整理のように Claude がチャットで読むとき、`retro-artifact` などの振り返り）が黙って欠ける（人に判断してほしいこと）
- **`--active` の絞り込みを `getStatusQuery` に入れる:** 報告の組み立てと次の一手の段（`withImplStep`）が引数で分かれ、入口ごとの出し方の話が usecase に入る。`--only` と同じ CLI の出し方に置く

### Risks / Trade-offs

- 中止のカードの PR を人が GitHub で reopen しても、カードが中止のあいだは控えの古い状態のまま見える。中止の区画に入るので、判断と次の一手には効かない
- クラウドのセッションのような、控え（`cache/`）の無いまっさらな clone では、中止のカードの閉じた PR を最初の `status` で一度ずつ引く（今は 2 枚）。2 回目の `status` から引かない
- `--active` を付けた `cards` には、マージ済みと中止のカードが無い。終わったカードの記録を読む読み手は付けずに読む

### Non-Goals

- `ai-board card list` に中止を外す指定を足すこと（C-3。2026-11-07 のチャットで見送った。人に判断してほしいこと）
- 状態ごとのフォルダ・archive・索引ファイルなど、データの持ち方を変えること（`### 退けた代案`）
- 届かないとき（「GitHub: 使えません」）に中止のカードのマージ前の控えを使うこと
- 人向けの `status` の出力を変えること
- `board-loop` の手順書の読み出し（`--only next,waiting,forge,loop`。`cards` を読まない）を変えること

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                         | 反映した先                                           | 反映しなかった理由 |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------ |
| 1   | 2026-11-07 のチャットで、人が C-1 と C-2 を 1 枚で起票するよう頼んだ。`card list` に中止を外す案は見送った   | 人に判断してほしいこと・Non-Goals                    |                    |
| 2   | `waiting` / `working` / `ideas` は今も生きているカードだけを持つので変えない                                 | What Changes                                         |                    |
| 3   | データ用ブランチの形の版（`ai-board-data.yaml`）は上げない                                                   | Impact・退けた代案                                   |                    |
| 4   | 論点: C-1 の控えの扱い。`forgetUntracked` が控えを消す。控えの無い中止のカードを一度引くか                   | Decisions（C-1）・退けた代案・人に判断してほしいこと |                    |
| 5   | 論点: 中止を確かに終端とみてよいか                                                                           | 仮定（中止は終端とみてよい）・Risks                  |                    |
| 6   | 論点: C-2 の既定は全件のまま                                                                                 | Decisions（C-2）・人に判断してほしいこと             |                    |
| 7   | 論点: C-2 の指定の形。`--active` か `--section` か。`--only` と組み合わせる                                  | Decisions（C-2）・退けた代案・人に判断してほしいこと |                    |
| 8   | 論点: 書く場所。`docs/architecture.md` か ADR 0003。`stage-resolver.ts` と ADR 0001 には触らない             | 仮定（ADR は書かない）・タスク 3                     |                    |
| 9   | 背景: カード 90 枚の読み込みは約 12ms、`status` 1 回の問い合わせ 3 回のうち 2 回が中止のカード、出力約 233KB | 提案（Why）                                          |                    |

## 動作確認の手順

作業するチェックアウトを `$WT` とする。`rules.md` の「動かして確かめるとき」のとおり、共有のカードを汚さないよう `AI_BOARD_DATA` でスクラッチの clone を指す。
今のデータで回数を比べるため、スクラッチの bare リポジトリ（`$S/origin.git`）に `$MAIN` の `ai-board/data` ブランチを複製して push し、その clone（`$S/data`）を指す。本物の `origin` には push しない。
GitHub への問い合わせは読むだけ（`gh api` の GET）で、本物の PR を引く。回数は、`gh` の前に呼ばれた引数を 1 行ずつ書き出す包み（`$S/shim/gh`）を `PATH` の先頭に置いて数える。
以下 `B` は `AI_BOARD_DATA=$S/data PATH=$S/shim:$PATH node $WT/dist/cli.js` を指す。

1. 中止のカードの閉じた PR を 2 回目から引かない
   - コマンド: `B status --json >/dev/null` を 2 回走らせ、2 回目に記録した `gh api` の行を見る
   - 期待: 2 回目に `pulls/29` と `pulls/36`（中止の `loop-dummy` / `loop-worker-dummy`）を引かない。今は毎回引いている
2. 中止のカードの `prState` は消えない
   - コマンド: 2 回目の後に `B status --json --only cards.id,cards.prState` で `loop-dummy` を見る
   - 期待: `prState` が `number: 29`・`state: closed` のまま出る
3. `--active` で終わったカードが外れる
   - コマンド: `B status --json --active --only cards.id,cards.stage | wc -c` と、付けないときの同じコマンド
   - 期待: `--active` 付きの `cards` に マージ済み と 中止 のカードが無く、出力が小さい。`ideas` と `waiting` は付けないときと同じ
4. `board-decide` の手順 1 の読み出しが小さくなる
   - コマンド: `B status --json --active --only waiting,ideas,cards.id,cards.title,cards.stage,cards.skipGates,cards.latestReview,cards.prState | wc -c`
   - 期待: 今の約 69KB より大きく小さい
5. `--active` の誤りは出す前に失敗する
   - コマンド: `B status --active`（`--json` 無し）、`B status --json --active --active`
   - 期待: どちらも使い方を出して終了コード 1
6. 人向けの出力は変わらない
   - コマンド: `B status`
   - 期待: 今と同じ数行（GitHub の接続・ループ・判断待ち・AI 作業中・次の一手）

## タスク

### 1. 中止のカードの PR を引き直さない

- [x] `src/board/services/pr-state-provider.ts` に `isFrozen(card, snapshot)` を足す（控えがあり、番号が合い、`## レビュー` の最新が 中止 なら真）
- [x] `src/infrastructure/pr-fetcher.ts` の `refreshCard` で、`isSettled` か `isFrozen` が真なら引き直さずに返す。docstring に中止のカードの扱いを書く
- [x] テスト: `isFrozen`（中止で番号が合えば真・中止でなければ偽・控えが無ければ偽・番号が違えば偽）、`PrFetcher`（中止のカードは控えがあれば引かず控えを返す・控えが無ければ一度引く・控えを消さない・中止でない閉じた PR は今どおり引く）

### 2. `status --json --active`

- [x] `src/board/services/board-sections.ts` に `isActiveCard` を足す（区画が マージ済み でも 中止 でもなければ真）
- [x] `src/board/cli/status-cli.ts` に `--active` を足す（解釈・`--json` 無しや 2 回目は誤り・`cards` の絞り込み・`--only` との組み合わせ・使い方）
- [x] テスト: `isActiveCard`（各区画）、`parseStatusArgs`（`--active` の組み合わせと誤り）、`runStatusCli`（`--active` で `cards` が絞られ、ほかの項目は変わらない・`--only` と組み合わさる）

### 3. 手順書とドキュメント

- [x] `.claude/skills/board-decide/SKILL.md` の手順 1 の読み出しに `--active` を足す
- [x] `docs/architecture.md` の `status` の出力の箇条に `--active` を、「控え」の箇条に中止のカードを引き直さないことを書く
- [x] `README.md` の `status` の使い方に `--active` を、「GitHub との接続」の問い合わせの対象の説明に中止のカードの扱いを書く
