# 動作確認の列を無くし、人の確かめを PR中 の 1 回にまとめる

## 提案

### Why

今は 実装中 → 動作確認 → PR中 の流れで、すべてのカードで人を 2 回待つ（ADR 0005）。
小さな変更は「動作確認を飛ばす」で人を待たずに済ませているが、そのために宣言の読み方（ADR 0009）、verify の保留、
Draft に戻されたときの止まり、`revise-impl` / `ready` の 2 つの手が増え、ループの手順書と導出の両方が重くなった。

ADR 0005 が防ごうとしたのは、「差分を読んだ後に動かして意図との違いに気付き、直した後にもう一度差分を読む」二度手間である。
AI が自分で動かした手順と結果を PR の本文の先頭に書いておけば、人は PR を開いたときにまず振る舞いの証拠を読み、
必要なら手で動かし、それから差分を読める。1 回の PR中 の中で「動かす → 読む」の順を守れるので、列を分けなくてよい。

### What Changes

使う人から見た変化:

- 列が 1 つ減って 6 つになる。`[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ PR中 ] [ マージ済み ]`。人を待つのは 計画レビュー と PR中 の 2 か所
- AI は実装と AI レビューを終えたら、PR の本文に「動作確認の結果」の節を書き、計画を archive へ移して PR を Ready にする（今の「動作確認を飛ばす」の道と同じ締め方）
- PR の本文の先頭近くに、次の節が並ぶ。人は上から読めば「動かした証拠 → 判断してほしいこと → 見送った指摘 → 差分」の順になる
  - `## 動作確認の結果`: 人が動かすときの手順（起動のコマンド、見る画面、期待する結果）、AI が動かした結果、計画の手順から変わった点、AI が確かめられなかった部分
  - `## 判断してほしいこと`: 計画の `## AI レビュー` 節の `### 人に判断してほしいこと`（無ければ節を書かない）
  - `## 見送った AI レビューの指摘`（今と同じ）
- 詳細パネルの「動作確認を飛ばす」のチェックボックスが無くなる。「計画レビューを飛ばす」だけが残る
- 動作確認の判断のボタン（承認 / 否決して差し戻す / 実装を直させる）が無くなる
- 差し戻しは PR のレビューのコメントで行う。コメントに AI が応える道は `pr-feedback-ai-turn` で作る（このカードでは作らない）。
  それまでの間に AI に作り直させたいときは、PR を Draft に戻して止まりにし、「計画から立て直させる」を押す（今もある道）

中の仕組みの変化:

- ゲートは `plan` の 1 つだけになる。ステージから `verifying` が、導出の規則から 3 番（verifying）が消える
- 次の一手から `revise-impl` と `ready` が消える。実装中のカードの手は常に `implement`（段は `task` / `review` / `close`）
- 止まりから `verify 保留` が消える。実装中の止まりは「判断の後に人が PR を Draft に戻した」だけが残る
- `ai-board card submit` / `hold` の `--gate` は `plan` だけを受け付ける。`--gate verify` は使い方の誤りとして拒む
- `skipGates` は `plan` だけを受け付ける

既にあるデータの読み方（データ用ブランチの形の版は上げない）:

- カードの `## レビュー` に残る `verify` のエントリ（判断のファイル `log/...verify...`）は、`explore` を消したときと同じく、規定外のゲートとして黙って読み飛ばす。記録は消さない
- `skipGates` に残る `verify`（マージ済みの `windows-shell` / `remove-sqlite` の 2 枚）は、読むときに落とす。書くときは受け付けない
- ループの 1 手の記録（`loop/`）に残る `revise-impl` / `ready` の手（14 件）は、過去の手として読める。`ai-board loop start` では渡せない
- 今、動作確認と実装中にいるカードは 0 枚（2026-11-03 に確かめた）。移り途中のカードは無い

### Impact

- 型と導出: `src/cards/models/review.ts`、`src/cards/models/schemas/card.schema.ts`、`src/cards/services/review-log.ts`、`src/cards/repositories/card-files.ts`、
  `src/shared/schemas/common.ts`、`src/board/services/stage-resolver.ts`、`src/board/services/next-action.ts`、`src/board/models/board-card.ts`
- CLI: `src/cards/cli/card-cli.ts`、`src/board/cli/loop-cli.ts`、`src/shared/loop-step.ts`、`src/board/repositories/loop-history.repository.ts`
- 見せ方: `src/shared/stage-gates.ts`、`src/shared/stage-labels.ts`、`src/shared/dashboard-sections.ts`、`src/shared/review-labels.ts`、
  `src/shared/timeline.ts`、`src/board/services/stage-timeline.ts`、`src/board/cli/status-charts.ts`、`src/shared/board-metrics.ts`、
  `src/web/types.ts`、`src/web/components/detail/SkipGateField.tsx`・`ReviewActions.tsx` ほか列を並べる画面
- 手順書: `.claude/skills/board-loop/`（`SKILL.md`・`implement.md`・`rules.md`・`plan.md`）、`.claude/skills/board-decide/SKILL.md`、`.claude/agents/board-reviewer.md`
- ドキュメント: `README.md`、`CLAUDE.md`、`docs/architecture.md`、`docs/specs/`（`board-stages`・`board-hold`・`board-timeline`・`card-gate-skip`・`card-review-authority`・`card-review-log`）、
  `docs/adr/`（0005 を書き直す、0006・0009・0011 から verify を外す、README の表）
- API: `GET /api/board` の `stage` から `verifying` が、`gates` から `verify` のキーが消える。`POST /api/cards/:id/reviews` と `PATCH /api/cards/:id` の `skipGates` は `verify` を受け付けなくなる。ローカル専用で外部の利用者は無い

## 設計

### Decisions

#### 1. 廃止した `verify` ゲートは、`explore` と同じく規定外のゲートとして黙って読み飛ばす

`REVIEW_GATES` を `['plan']` にすると、`parseReviewLog` と判断のファイル名の読み（`card-files.ts` の `toLogName`）は `verify` を規定外として捨てる。
判断のファイル名の読みは今 `plan` / `verify` を直書きしているので、`isReviewGate` に寄せる。読み飛ばしで警告は出さない（廃止したゲートで、壊れたファイルではないため）。
`## レビュー` は人の判断の追記専用の履歴なので、列の定義が変わったことを理由に過去の記録を消さない（`drop-explore-lanes` と同じ）。

`skipGates` は `explore` のときと事情が違い、`verify` を持つカードが 2 枚ある。Zod の検証で落とすとカードが読めなくなるので、
読むスキーマ（frontmatter）だけは、規定外の値を落としてから `plan` の配列として検証する。書くスキーマ（`PATCH`）は `plan` だけを受け付ける。
読み落とした値はカードを書き直したときに消えるが、意味を持たない値なので構わない。

#### 2. 締めの段は、今の「動作確認を飛ばす」の道を唯一の道にする

`implement` の締めの段（`next.step` が `close`）は、今 `skipGates` の `verify` で 2 つに分かれている。飛ばす側の道だけを残し、次の順に行う。

1. 計画の `## 動作確認の手順` を、動かせるところ（CLI、API など）は共通の決まりの「動かして確かめるとき」に従って動かす
2. PR の本文に `## 動作確認の結果`・`## 判断してほしいこと`・`## 見送った AI レビューの指摘` の 3 節を書く（下の 3）
3. 計画を archive へ移してコミット → push → `ai-board pr ready`

今の `verify 提出` の本文に書いていた項目（手順・動かした結果・計画から変わった点・確かめられなかった部分・人に判断してほしいこと）は、
そのまま PR の本文の節へ移す。推測で「確認した」と書かない決まりも移す。

次の一手は `implement` の 1 つになる。`ready` は「verify を通った後に Ready にする」手で、締めの段が自分で Ready にするので要らない。
`revise-impl` は verify の否決を直す手で、否決が無くなるので要らない。
`archive 済み` の段（`plans/archive/` にあり、`ai-board pr ready` だけが失敗した）は今のまま残す。

#### 3. 証拠は PR の本文に書き、`verify-evidence` の前に入れる

`verify-evidence` を待たずにこのカードを入れる。今の `verify 提出` の本文と同じ量の証拠（AI が動かした手順と結果、確かめられなかった部分）は、
このカードの締めの段で PR の本文に移るので、人が PR中 で手で全部動かすことにはならない。
表にしたテストの報告、CI の結果、スクリーンショットのような厚い証拠は `verify-evidence` に残す。

置き場所はコメントではなく本文にする。人は PR を開くと本文をまず読み、コメントは議論で流れていく（今の見送った指摘と同じ理由）。
節の順は「動作確認の結果 → 判断してほしいこと → 見送った指摘」にし、本文の計画の要約より後ろ、署名より前に置く。
振る舞いを先に、コードを後に読む順は、この本文の並びで示し、列では分けない。

#### 4. 実装中の止まりは「判断の後に人が PR を Draft に戻した」だけを残す

カードのアイデアは Draft と Ready の出し入れに伴う止まりも消すとしているが、これは残す。
消すと、人が PR中 の PR を Draft に戻したとき、カードは 実装中 に落ち、計画は archive 済みなので次の一手が `archive 済み` の段になり、
ループが `ai-board pr ready` で Ready に戻してしまう。これは ADR 0006 が防いだ形そのものである。

止まりの判定（`draftReverted`）はそのまま使う。基準の「人の最新の判断」は plan の承認（plan を飛ばすカードは plan の提出）になる。
計画の Draft の PR は作成時から Draft で `convert_to_draft` のイベントを残さないので、実装中のあいだに止まりが立つことは無い。
止まりのボタンは「計画から立て直させる / 中止」の 2 つにする（「実装を直させる」は verify の否決なので消える）。
`pr-feedback-ai-turn` が入るまでは、PR中 で AI に直させたいときにこの道を使う。

#### 5. 中止は plan のゲートに書く

今 実装中 と 動作確認 の中止のボタンは `verify 中止` を書いている。中止は「最新のエントリが中止か」（`isAborted`）で読むのでゲートは問わない。
実装中の中止は `plan 中止` に変える。人の API の `POST /api/cards/:id/reviews` は、plan の承認後でも `plan 中止` を受け付けることを確かめ、受け付けなければ受け付けるように直す。

#### 6. ループの 1 手の記録は、過去の手を読めるまま残す

`LOOP_ACTIONS`（記録を読むときの語彙）は今の手の `plan` / `revise-plan` / `implement` に、過去の手の `revise-impl` / `ready` を足したものにする。
`ai-board loop start --action` に渡せるのは今の手だけにし、今の手と `NextActionKind` が食い違えば型エラーになる縛り（`LOOP_VOCABULARY_IN_SYNC`）は今の手の方で保つ。
過去の手の記録は、画面と `status --html` のログに今までどおりの語で出る。

#### 7. 工程にいた時間（timeline）は、`verify` のエントリを読まなくなるぶん、過去のカードの区間が変わることを受け入れる

timeline は `## レビュー` のエントリから区間を導く（ADR 0008）。`verify` のエントリを読み飛ばすと、
マージ済みのカードの「動作確認」「実装の直し」「実装の保留」の区間は無くなり、その時間は前後の区間（実装 / Ready にする / PR レビュー）に含まれて見える。
過去の区間を残すために `verify` を読むだけの経路を持つと、消したゲートの解釈がコードに残り続けるので、持たない。
否決の枚数（`board-metrics`）も plan の否決だけを数えるようになる。PR のレビューでの差し戻しをどう数えるかは `harness-metrics` に残す。

### Risks / Trade-offs

- 人が手で動かす場面が PR中 の中に入り、「まず動かす」が人の心がけになる → PR の本文の節の順で示す。守られずに二度手間が戻るようなら、`verify-evidence` で証拠を厚くする
- `pr-feedback-ai-turn` が入るまでは、PR中 での小さな直しを AI に頼む道が「Draft に戻して計画から立て直させる」しかなく重い → 人がチャットで直接頼む運用で受ける。このカードの PR の本文に書く
- 過去のカードの timeline と否決の枚数の見え方が変わる（Decisions 7）
- タスクの 1 の節は、変わるファイルが十数個の目安を超える。`Stage` と `ReviewGate` から値を 1 つ消すと、`Record<Stage, …>` などの網羅の表（サーバ・shared・web・timeline の対応）が一度に型エラーになり、途中で品質ゲートを通せる切れ目が無いため。
  使われなくなるだけで型を壊さない区間の種類（timeline の区間の語）は 2 の節に分けた
- このカード自身は、今の main の CLI（verify ゲートがある）の上で回るので、このカードの PR は今までどおり動作確認の列を通る

### Non-Goals

- PR のレビューのコメントに AI が応える道（`pr-feedback-ai-turn`）
- テストの表・CI の結果・スクリーンショットのような厚い証拠（`verify-evidence`）
- 研修の題材の扱い（`training-seed`。題材はまだ無い）
- 差し戻しの回数のメトリクス（`harness-metrics`）
- 既にあるカードの `## レビュー` から `verify` のエントリを消すこと、データ用ブランチの形の版を上げること

## 動作確認の手順

共通の決まりの「動かして確かめるとき」のとおり、スクラッチパッドの bare リポジトリを `origin` にした clone を `AI_BOARD_DATA` で指す。

1. `npm run build` の後、`AI_BOARD_DATA=<clone> node dist/cli.js init` で空のボードを作り、`card create` でカードを 1 枚作る
2. `node dist/cli.js` でサーバを起動し、ブラウザで開く
   - 列が「アイデア / 計画提案中 / 計画レビュー / 実装中 / PR中 / マージ済み」の 6 つである
   - カードの詳細パネルのゲートの欄に「計画レビューを飛ばす」だけがあり、「動作確認を飛ばす」が無い
3. `node dist/cli.js card submit <id> --gate verify` が使い方の誤りで失敗する。`card hold <id> --gate verify --reason x` も同じ
4. clone のカードの frontmatter に `skipGates: [verify]` と、`log/` に `verify 提出` の判断のファイルを手で置いてコミットし、
   `node dist/cli.js status --json` がエラーにならず、そのカードの `skipGates` が `[]` で、ステージが verify の無いときと同じである
5. clone の `loop/` に `action: ready` の記録を置き、`status --html` のログにその手が出る。`loop start --action ready` は失敗する
6. 本物のボード（`AI_BOARD_DATA` を指さない）で `node dist/cli.js status --json` を読み、マージ済みの `windows-shell` / `remove-sqlite` が読めていて、警告が出ない（読むだけ。書かない）

## タスク

### 1. ゲートとステージから verify を外す

- [x] `src/cards/models/review.ts` の `REVIEW_GATES` を `['plan']` にし、docstring に廃止した `verify` も `explore` と同じく黙って読み飛ばすことを書く
- [x] `src/cards/repositories/card-files.ts` の `toLogName` のゲートの判定を `isReviewGate` に寄せ、`verify` の判断のファイルを警告なしで読み飛ばす
- [x] `src/cards/models/schemas/card.schema.ts` の frontmatter の `skipGates` を、規定外の値を落としてから検証する形にする。`PATCH` のスキーマは `plan` だけを受け付ける
- [x] `src/cards/services/review-log.ts` の `gateStates` と後ろのゲートの区切り（plan の承認より古いエントリを数えない）を、ゲートが `plan` だけになった形に直す
- [x] `src/shared/schemas/common.ts` の `STAGES` から `verifying` を消し、`src/board/services/stage-resolver.ts` の `RULES` から 3 番を消して docstring の表と説明を直す
- [x] `src/board/services/next-action.ts` から `revise-impl` / `ready` を消し、実装中は止まっていなければ常に `implement` を返す。`resolveHold` の実装中は `draftReverted` だけにし、`HOLD_REASONS.verifyHeld` を消して `draftReverted` の文から「差し戻す」を「計画から立て直させる」に直す
- [x] `src/cards/cli/card-cli.ts` の `submit` / `hold` の `--gate` を `plan` だけにし、使い方の文と `verify` の提出の条件を消す
- [x] `src/shared/loop-step.ts` を今の手と過去の手に分け（Decisions 6）、`loop-history.repository.ts` と `loop-cli.ts` を合わせる
- [x] 人の API の `plan 中止` が plan の承認後でも書けることを確かめ、書けなければ書けるようにする（Decisions 5）
- [x] `src/shared/stage-gates.ts`（`GATE_OF_STAGE` と `offersSkipVerify`）、`src/shared/stage-labels.ts`、`src/shared/review-labels.ts`、`src/board/models/board-card.ts` から verify を外す
- [x] `src/shared/dashboard-sections.ts` の区画と判断のボタンを直す。動作確認の列のボタンを消し、実装中の止まりのボタンを「計画から立て直させる / 中止（plan）」にする
- [x] `src/board/services/stage-timeline.ts` の `REVIEW_TRANSITIONS` から `verify:*` を消し、`verify 承認` の `readying` の読み替えの説明を直す（区間の種類そのものは 2 で消す）
- [x] `src/web/types.ts` の `Stage` / `ReviewGate` / 列の表（所有者・ゲート・`GATE_STAGES`）から verify を外し、`src/web/components/detail/SkipGateField.tsx` を「計画レビューを飛ばす」だけにする。
      `ReviewActions.tsx` ほか `verifying` を参照する画面の部品があれば直す
- [x] 上の変更に合わせて、`stage-resolver` / `next-action` / `card-cli` / `card-files` / `review-log` / `card-commands` / `dashboard-sections` / `stage-gates` / `review-labels` / `loop-cli` / `loop-history` / `loop-activity` / `stage-timeline` / `status-cli` / `board.e2e` のテストを直す。
      verify のエントリと `skipGates: [verify]` を持つカードが読めてステージが変わらないこと、`--gate verify` を拒むこと、過去の手の記録が読めることのテストを足す

### 2. 使われなくなった工程の区間と語を消す

- [x] `src/shared/timeline.ts` から `verifying` / `verify-rework` / `verify-held` の区間を消し、`src/board/cli/status-charts.ts` の区間の語を合わせる
- [x] `src/shared/board-metrics.ts` の否決の数え方の docstring を、plan の否決だけを数える形に直す
- [x] `timeline` / `timeline-phases` / `board-metrics` / `board-log` / `status-html` のテストを直す

### 3. ループと判断の手順書を直す

- [x] `.claude/skills/board-loop/implement.md` から `revise-impl` / `ready` の節を消し、締めの段を Decisions 2・3 の形（動かす → PR の本文の 3 節 → archive → Ready）にする。手の終わりと ハードルールの verify の記述を直す
- [x] `.claude/skills/board-loop/SKILL.md` の手の表・動作確認の説明・止まりの説明、`rules.md` の「直しきれないとき」（`--gate verify` を消す）と「指摘の分け方」の `revise-impl`、`plan.md` の `revise-plan` の verify の記述を直す
- [x] `.claude/skills/board-decide/SKILL.md` から「動作確認を飛ばす」と verify の判断を消し、`.claude/agents/board-reviewer.md` に verify の記述があれば直す

### 4. ドキュメントと ADR を直す

- [x] `README.md`（列の図・判定表・判断のボタンの表・スキップ・CLI の使い方・次の一手の表）と `CLAUDE.md`（列の図・CLI の使い方・ハードルールの verify）を直す
- [x] `docs/architecture.md` と `docs/specs/` の `board-stages` / `board-hold` / `board-timeline` / `card-gate-skip` / `card-review-authority` / `card-review-log` を今の形に直す
- [x] ADR 0005 を「動作確認を独立した列に置かず、AI の証拠を PR の本文に書いて PR中 で確かめる」に書き直し（ファイル名も合わせる）、0006・0009・0011 から verify を外し、`docs/adr/README.md` の表を直す
