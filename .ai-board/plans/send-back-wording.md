# 計画を返す判断を「否決」から「差し戻し」と呼び替える

## 人に判断してほしいこと

- **`status --json` の種別の値を変えてよいか。** `cards[].latestReview.kind` と `waiting[].decisions[].kind` の値が `否決` から `差し戻し` に変わる。
  値で分岐する読み手がこのリポジトリの外にあれば壊れる（既定: 変える。読み手はこのリポジトリのスキルだけで、同じ PR で直す）
- **`board-decide` で「否決して」と頼まれたとき、差し戻しとして受けるか。** 言い慣れた言い方で頼まれることが当面ありうる（既定: 受ける。スキルの読み分けに「否決して」も差し戻しの依頼として挙げる）
- **古い言い方の `### <時刻> plan 否決` を読み替えるか。** 古い CLI の `card show` の出力を直して新しい CLI の `card body` に送ると、`否決` の見出しを読めずにエントリが変わったと見なされ、書き込みを拒まれる（既定: 読み替えない。拒まれるだけでデータは壊れず、`card show` を取り直せば通る）
- **どこまで書き換えるか。** 今の形を書いた文書（README・CLAUDE.md・REVIEW.md・`docs/architecture.md`・ADR・仕様・スキル）は書き換える。
  archive の計画、既存のカード本文の自由記述、`.claude/HARNESS_VERSIONS.md` の過去の版の記述は、当時の記録として残す（既定: この線引きのまま）
- **手順書の版を上げるか。** スキルの読み分けと、`status --json` から読む種別の値が変わるので、`.claude/HARNESS_VERSIONS.md` に `v5` を足す（既定: 上げる）

承認は、回答の無い項目をすべて既定のまま進めると読む。既定と違う答えは、承認の理由ではなく否決（この計画で「差し戻し」に改める判断。今の CLI では `decide reject`）の理由で返してほしい。

## 提案

### Why

人が計画レビューで計画を返す判断を、今は「否決」と呼んでいる。
「否決」は案そのものを退ける響きが強い。
実際にこの判断で起きるのは、計画を退けることではなく、理由を添えて AI に直させ、もう一度出させることである（カードは手前の AI の列へ落ち、AI が直して再提出する）。
この流れは「差し戻し」と呼ぶほうが実態に合う。
否決と書くたびに AI の仕事を否定するような響きがあり、人が気軽に返しにくくなるのも避けたい。

### What Changes

- 判断の種別 `ReviewKind` の `否決` を `差し戻し` にする（`src/cards/models/review.ts`）。`## レビュー` のエントリの見出しは `### <時刻> plan 差し戻し` になる
- 種別を使う箇所（ゲートの状態・タイムライン・出せる判断・`decide` の検査とメッセージ・`card` の CLI のエラー文言・次の一手の理由）と、コードのコメント・テストを、差し戻しの呼び名に合わせる
- 出せる判断のラベル「否決して差し戻す」を「差し戻す」にする
- `ai-board decide reject` の使い方の説明を「plan を差し戻す（理由は必須）」にする
- スキル（`board-decide` / `board-loop` / `adr`）、README・CLAUDE.md・REVIEW.md・`docs/architecture.md`・ADR・仕様の「否決」を、今の形として書き換える
- `.claude/HARNESS_VERSIONS.md` に `v5` を足す（人に判断してほしいこと）

### Impact

- 保存の形は変わらない。`log/` のファイル名は英字の `reject` のままで、日本語の種別は読むときに当てる名前である。既存のカードは移行せずに読め、データの形の版（`ai-board-data.yaml`）も上げない
- 古い CLI と新しい CLI が同じデータを読んでも、どちらも読める（ファイル名が同じため）。表示の呼び名だけが違う
- `status --json` の `kind` の値と、`status` と `decide` の人向けの出力の文言が変わる（人に判断してほしいこと）
- `ai-board card body` に古い CLI の出力の `否決` の見出しを送ると拒まれる（人に判断してほしいこと）

## 設計

### Decisions

- **英字の識別子は変えない。** CLI のサブコマンド `decide reject`、`log/` のファイル名の `reject`、ゲートの状態の `rejected`、コードの関数名 `reject` / `replan`、次の一手の `revise-plan` はそのままにする
- **日本語の種別は `差し戻し` の 1 語にする。** `## レビュー` の見出しは `### <時刻> <ゲート> <種別>` を空白で区切って読む（`review-log.ts` の `ENTRY_HEADING`）ので、空白を含まない 1 語にする
- **動詞の形は文ごとに書き直す。** 「否決する」は「差し戻す」、「否決された」は「差し戻された」、「否決の理由」は「差し戻しの理由」、「否決を直す」は「差し戻された計画を直す」のように、文が通る形にする。機械的な置き換えだけで済ませず、置き換えた行を読み直す
- **二つの語が重なる文は縮める。** 「否決の差し戻しに専用ルールは無く」は「差し戻しに専用ルールは無く」に、「否決して差し戻す」は「差し戻す」にする
- **`board-decide` は「否決して」も差し戻しの依頼として受ける。** 手順 2 の読み分けに 1 行足す（人に判断してほしいこと）
- 状態の説明に出る「差し戻し中」（README の `rejected` の説明）は、そのまま使える

### 仮定

- `status --json` の `kind` を値で読むのは、このリポジトリのスキルだけである。根拠: `board-decide` と `board-loop` は `waiting[].decisions` の `label` と `latestReview.reason` を読み、`kind` の値で分岐する手順は無い。外の読み手は知られていない
- 保存されたデータに日本語の種別は残っていない。根拠: `card-files.ts` の `REVIEW_KIND_NAMES` が種別を英字のファイル名に写し、`card.md` に `## レビュー` 節は保存されない（`card show` が `log/` から組み立てる）。データのワークツリーにも `### … plan 否決` の見出しを持つ `card.md` は無い
- データの形の版は上げない。根拠: ファイルの名前も中身の形も変わらないため（CLAUDE.md の「形の版を上げて push すると、メインの古い版の CLI がカードを読めなくなる」を避ける）
- 理由の本文（人が書いた言葉）に「否決」が含まれていても書き換えない。人の言葉はそのまま残す決まり（`board-decide` の「理由」）に合わせる

### 退けた代案

- 英字の識別子も `send-back` などに改める: ログのファイル名の読み替えか既存データの移行が要り、データの形の版も上がる。人と決めた範囲（日本語の表記だけ）を越える
- 読むときに `否決` を `差し戻し` の別名として受ける: 拒まれてもデータは壊れず、別名を持つと種別が 2 通りに書ける余地が残る（人に判断してほしいこと）
- archive の計画や過去の版の記述も書き換える: 当時の判断の記録で、書き換えると git の履歴と食い違う（人に判断してほしいこと）
- 「差戻し」と送り仮名を省く: 一般的な表記の「差し戻し」に揃える

### Risks / Trade-offs

- 書き換えの行数が多い（コード・テストで約 130 行、文書とスキルで約 150 行）。機械的に置き換えると「差し戻しの差し戻し」のような文が残るので、置き換えた行を読み直す
- 種別の値を変えると、型の上で `'否決'` を使うすべての箇所が一度に壊れる。コードとテストは同じ節で倒す
- 古い CLI（メインのチェックアウトの `dist/`）では、マージしてビルドし直すまで「否決」と表示される

### Non-Goals

- 英字の識別子（`decide reject`・`reject`・`rejected`・`revise-plan`）を変えない（人と決めた。2026-11-06）
- データの形の版を上げない。既存のデータを移行しない
- archive の計画、既存のカード本文、`.claude/HARNESS_VERSIONS.md` の過去の版の記述を書き換えない（人に判断してほしいこと）
- `否決` を読み替える別名を持たない（人に判断してほしいこと）
- 承認・中止・保留など、ほかの種別の呼び名は変えない

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                             | 反映した先                              | 反映しなかった理由 |
| --- | ---------------------------------------------------------------- | --------------------------------------- | ------------------ |
| 1   | 人と決めた（2026-11-06）: 変えるのは日本語の表記だけ             | Decisions、Non-Goals                    |                    |
| 2   | 人と決めた（2026-11-06）: アイデアカードを起票してボードで進める | この計画そのもの                        |                    |
| 3   | カードの論点: CLAUDE.md の二つの語が並ぶ文の言い換え             | Decisions（二つの語が重なる文は縮める） |                    |
| 4   | カードの論点: `board-decide` で「否決して」を受けるか            | Decisions、人に判断してほしいこと       |                    |

カードに `## 探索メモ` の節は無い。上の表は、起票の会話で人と決めたことと、カードの `## 論点` を並べた。

## 動作確認の手順

共有の `origin` の `ai-board/data` に書かないよう、本物のデータ用ブランチをスクラッチパッドへ bare で clone し、それを `origin` にした clone を `AI_BOARD_DATA` で指す（共通の決まりの「動かして確かめるとき」）。
既存のカードと `config.yaml` がそのまま入るので、既存のデータが読めるかも同じ clone で確かめられ、GitHub にも繋がる。

```bash
S=<スクラッチパッドの下の作業用ディレクトリ>
git clone --bare --branch ai-board/data git@github.com:iepyon/ai-board.git "$S/origin.git"
git clone --branch ai-board/data "$S/origin.git" "$S/data"
export AI_BOARD_DATA="$S/data"
```

試しのカード `try-send-back` を計画レビューまで立てるには、`ai-board card create` → `ai-board decide start` の後に、`$WT/.ai-board/plans/try-send-back.md` を一時的に置いて `ai-board card submit` を書く（計画ファイルがあれば計画レビューの列が立つ）。
一時の計画ファイルは確かめ終えたら消し、コミットしない。

| 確かめること                                        | コマンド                                                                                                | 期待する結果                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 既存のカードが読める                                | `node dist/cli.js status --root "$WT"`                                                                  | 失敗せずに出力され、`reject` のログを持つカード（`verify-gate` など）も今までと同じ列にいる                         |
| 計画レビューの判断のラベルが「差し戻す」            | 試しのカードを計画レビューまで立て、`node dist/cli.js status --json --only waiting --root "$WT"`        | `try-send-back` の `decisions` に `{ "kind": "差し戻し", "label": "差し戻す" }`                                     |
| 差し戻すと `## レビュー` に差し戻しと出る           | `node dist/cli.js decide reject try-send-back --reason 直して --root "$WT"` → `card show try-send-back` | `decide` の出力に「plan 差し戻し を書きました」、本文の `## レビュー` に `### <時刻> plan 差し戻し`                 |
| ログのファイル名は英字のまま                        | `ls "$AI_BOARD_DATA/cards/try-send-back/log/"`                                                          | `….plan.reject.md` がある                                                                                           |
| 差し戻したカードはループの手が `revise-plan` になる | `node dist/cli.js status --json --only next,cards.id,cards.latestReview --root "$WT"`                   | `try-send-back` の `latestReview.kind` が `差し戻し`。`next` がこのカードなら `revise-plan`・「計画が差し戻された」 |
| 1 手の記録が新しい版を残す                          | `node dist/cli.js loop start --loop t --card try-send-back --action revise-plan --root "$WT"`           | `status --json --only loop` の `running[].harness` が `v5`                                                          |
| 今の形の文書とコードに「否決」が残っていない        | `grep -rn "否決" src README.md REVIEW.md CLAUDE.md docs .claude`                                        | `.claude/HARNESS_VERSIONS.md` の過去の版と、`board-decide` の「否決して」を受ける 1 行だけが出る                    |

## タスク

### 1. 種別を「差し戻し」に変え、種別を使うコードとテストを合わせる

- [ ] `src/cards/models/review.ts` の `REVIEW_KINDS` の `否決` を `差し戻し` にし、docstring を直す
- [ ] 種別を使う本体（`review-log.ts`・`card-files.ts`・`stage-timeline.ts`・`dashboard-sections.ts`・`decide-cli.ts`・`next-action.ts`）と、人に見せる文言に「否決」を持つ `card-cli.ts`（使い方とエラー文言）を直す。出せる判断のラベル「否決して差し戻す」は「差し戻す」、`revise-plan` の理由は「計画が差し戻された」、`decide reject` の使い方は「plan を差し戻す（理由は必須）」にする
- [ ] テスト（`src/**/__tests__/` の 12 ファイル）の `'否決'` と期待する文言を直す

### 2. コメントと文言だけに「否決」を持つコードを直す

- [ ] `stage-resolver.ts`・`decision-guards.ts`・`card-errors.ts`・`composition.ts`・`hold-review.command.ts`・`submit-review.command.ts`・`loop-step.ts`・`timeline.ts` の「否決」を直す。どれもコメントだけで、振る舞いは変わらない

### 3. スキルを直し、手順書の版を上げる

- [ ] `.claude/skills/board-decide/SKILL.md` の「否決」を差し戻しに直し、手順 2 の読み分けに「『否決して』と頼まれても差し戻しの依頼として受ける」を足す
- [ ] `.claude/skills/board-loop/`（`SKILL.md`・`plan.md`・`rules.md`）と `.claude/skills/adr/SKILL.md` の「否決」を直す
- [ ] `.claude/HARNESS_VERSIONS.md` の先頭に `## v5` を足し、変わったことを書く（過去の版の記述は直さない）

### 4. 今の形を書いた文書を直す

- [ ] `CLAUDE.md`・`README.md`・`REVIEW.md`・`docs/architecture.md` の「否決」を直す。「否決の差し戻しに専用ルールは無く」は「差し戻しに専用ルールは無く」にする
- [ ] `docs/adr/` の 9 本（0001・0002・0004・0005・0006・0007・0009・0012・0013）の「否決」を、今の形として直す
- [ ] `docs/specs/` の 6 本（`board-hold`・`board-stages`・`board-timeline`・`card-gate-skip`・`card-review-authority`・`card-review-log`）の「否決」を直す
