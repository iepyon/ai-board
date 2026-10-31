# 計画レビューを飛ばすカードでも、着手してから計画を書かせる

## この計画で使う言葉

- **ゲート**：人の確認を通らないと先へ進めない関所。計画を読む `plan` と、実装を動かして確かめる `verify` の 2 つがある。
- **提出 / 再提出 / 承認 / 否決 / 保留 / 中止**：カード本文の `## レビュー` に 1 件ずつ追記されるエントリ。
  AI が書けるのは 提出 / 再提出 / 保留 だけで、承認 / 否決 / 中止 は人が書く。ゲートの状態はそのゲートの最新の 1 件で決まる。
- **飛ばす宣言（`skipGates`）**：人があらかじめ「このカードではこのゲートを見ない」と決めておく印。人だけが書ける（画面と API）。
- **読み替え**：この計画で入れる考え方。宣言のあるゲートでは、AI の 提出 / 再提出 を人の 承認 と同じに読む。

## 提案

### Why

計画は書かせたいが、読まずに通してよいカードがある。
夜間に `/loop` を回すときは、人が止まる場所を減らし、寝ているあいだに先まで進めてほしい。
plan を飛ばす宣言は、もともとこの用途のために入れたものである（`board-lanes` の計画）。

ところが、今の宣言はこの用途を満たしていない。
今の `gateState` は、宣言のあるゲートをログを見ずに `approved` と返す。
そのため plan を飛ばすカードは、計画提案中を通らずに実装中に入り、計画を書く手（`plan`）が一度も呼ばれない。
計画もブランチも Draft の PR もできないまま `implement` が渡され、`board-worker` はブランチが無いので止まる。

さらに、着手時刻が無くても実装中に入る。
人が着手を指示していないカードをループが選んでしまい、「`startedAt` は人が着手を指示する合図」という決まりとぶつかる。
今は plan の宣言を書く入口が API にしか無く、どのカードも使っていないので、実害は出ていない。

### What Changes

使う人から見た変化は次のとおり。

- plan を飛ばすカードも、着手するまではアイデアに留まる。着手すると計画提案中に入り、AI が計画を書いて Draft の PR を出す
- AI が計画を提出した時点で、計画レビューを通らずに実装中へ進む
- 詳細パネルのゲートの欄に「計画レビューを飛ばす」のチェックボックスが増える。`board-decide` のスキルでも頼める
- 宣言のあるゲートでも、人は否決 / 承認 / 中止を書ける。判断のボタンからも宣言のあるゲートの承認 / 否決を隠さない
- AI の `ai-board card submit`（plan ゲート）は、着手していないカードでは失敗する

中の仕組みの変化は次のとおり。

- ゲートの状態の読み方を、「宣言があればログを見ずに `approved`」から「宣言のあるゲートでは 提出 / 再提出 を `approved` と読む」に変える。
  否決 / 保留 / 承認 はふつうに効く。エントリが無ければ `none` である
- 後ろのゲートの古いエントリを外す区切り（`currentEntries`）も、同じ読み替えで「前のゲートの最新の承認」を決める
- 区間の並び（タイムライン）も同じ読み替えで、宣言のあるゲートの 提出 / 再提出 を 承認 と同じ区間の始まりにする。着手は常に `planning` を始める

### Impact

- ゲートの状態: `src/cards/services/review-log.ts`（`gateState` / `latestGateEntry` / `currentEntries`）
- 呼び出し側: `src/board/services/stage-resolver.ts`、`src/board/services/next-action.ts`（`HoldInput` に `skipGates`）、
  `src/board/usecases/queries/get-board.query.ts`（`latestReview` と `resolveHold` の呼び出し）、`src/cards/cli/card-cli.ts`
- タイムライン: `src/board/services/stage-timeline.ts`
- 見せ方: `src/shared/dashboard-sections.ts`（`decisionsFor`）、`src/web/components/detail/SkipGateField.tsx`
- ループとスキル: `.claude/agents/board-planner.md`、`.claude/agents/board-worker.md`、`.claude/skills/board-decide/SKILL.md`
- ドキュメント: `README.md`、`docs/architecture.md`、`docs/specs/card-gate-skip`・`card-review-log`・`board-timeline`・`board-hold`・`card-review-authority` の `spec.md`
- DB と API の形は変わらない（`skip_gates` の値の意味だけが変わる）。plan を飛ばす宣言を持つカードは今は無いので、移し替えも要らない

## 設計

### Decisions

#### 1 枚のカードはどう通るか

「計画レビューを飛ばす」に印を入れたカードを追う。

1. 印を入れても、`## レビュー` にエントリが無いので plan ゲートは `none` のまま。着手していなければアイデアに留まる
2. 人が着手を押すと計画提案中に入る。ループは `plan` を選び、`board-planner` が計画を書いて Draft の PR を出し、`plan 提出` を書く
3. `plan 提出` は承認と読まれるので、カードは実装中へ進む。ループは次の周から `implement` を選ぶ
4. ここから先はふつうのカードと同じ。動作確認を頼むか（verify も飛ばすなら Ready にするか）は verify の宣言で決まる

着手を戻せる範囲もふつうのカードと揃う。
提出の前は戻せて、Draft の PR を出した後や提出の後は戻せない（下限がそれより先の列になるため）。

#### 読み替えをどこで行うか

`gateState` の 1 か所で、宣言のあるゲートの 提出 / 再提出 を `approved` に読み替える。
ステージの規則（`RULES`）には手を入れない。plan の宣言のための `if` も、着手時刻の条件も足さない。
ルールは今までどおり `gates.plan === 'approved'` を見るだけで、その `approved` の出どころが変わるだけである。

`currentEntries` の区切りも同じ読み替えにする。
「承認、または宣言のあるゲートの 提出 / 再提出」を、そのゲートの承認として扱う。
そうしないと、plan を飛ばすカードで「計画から立て直させる」（plan 否決）→ `plan 再提出` と進んだとき、前の計画に対する古い `verify 否決` が最新のまま残る。
するとループは `implement` ではなく `revise-impl` を選び続ける（ふつうのカードで `currentEntries` が防いでいるのと同じ不具合）。

このため `latestGateEntry` は `skipGates` を受け取るようになる。
呼び出し側（`gateState`、`latestReview`、`resolveHold` の `draftReverted` と `since`）に `skipGates` を渡し、`HoldInput` に `skipGates` を足す。

読み替えは `latestGateEntry` が返すエントリの `kind` を書き換えない。
判断待ちの区画に出すエントリは `plan 提出` のまま見せる。AI が書いたものを人の承認と表示すると、誰が何を書いたかを読み違えるためである。

#### verify の宣言はどう変わるか

verify を飛ばすカードの `board-worker` は動作確認を頼まずに Ready にするので、verify ゲートは `none` のまま 実装中 → PR中 へ進む。
`judgeImpling` は `none` で `implement` を返すので、ふつうの道の振る舞いは変わらない。

変わるのは、人が verify を否決したときである。
今は宣言があれば否決がログごと無視されるが、これからは `rejected` になり、ループは `revise-impl` を選ぶ。
`revise-impl` の最後の `verify 再提出` は承認と読まれ、次の `implement` が締めの段で archive して Ready にする。
`judgeImpling` の「`approved` かつ宣言あり → `implement`」の分かれ道は、この 再提出 の後の道としてそのまま残す。

#### 判断のボタンから宣言のあるゲートを隠すのをやめる

`decisionsFor` は、宣言のあるゲートの承認 / 否決を出していない。
理由は「否決を書いても差し戻しにならない」ことだったが、読み替えの後は否決がふつうに効くので、この理由は無くなる。
隠したままだと、plan を飛ばすカードが実装中で止まったときに「計画から立て直させる」を押せず、verify を飛ばすカードで「実装を直させる」を押せない。
そこで絞り込みをやめ、宣言の有無によらず同じボタンを出す。`DecisionCard` から使わなくなる `skipGates` を外す。

#### AI の plan の提出を、着手したカードに限る

読み替えの後は、plan を飛ばすカードでは AI の `plan 提出` がそのまま承認になる。
着手していないカードに AI が提出を書けば、人の着手を経ずにアイデアから実装中へ進めてしまう。
ループは着手したカードにしか `plan` を渡さないので手順の上では起きないが、`CLAUDE.md` は書き込み境界を CLI の構造で守ると決めている。

そこで `ai-board card submit` の plan ゲート（`--resubmit` を含む）を、`startedAt` が null のカードでは失敗させる。
宣言の有無で分けず、すべてのカードに効かせる。
ふつうのカードでも、着手していないカードに AI が計画を出す道は無いので、振る舞いの上で失うものは無い。
verify の提出は今までどおり plan の承認を前提にしているので、新しい条件は足さない。

#### 宣言の入口

詳細パネルのゲートの欄に「計画レビューを飛ばす」のチェックボックスを足す。
「動作確認を飛ばす」と同じく `withSkipGate` で `plan` だけを出し入れし、他のゲートの宣言を保つ。
`board-decide` のスキルにも「計画レビューを飛ばす」の操作を足し、ハードルールの「`skipGates` の `plan` に触れない」を外す。
CLI には足さない（AI が自分で宣言を書けないことを、入口が無いことで守る）。

#### タイムライン

着手は宣言によらず `planning` を始める。
`REVIEW_TRANSITIONS` を引く前に、宣言のあるゲートの 提出 / 再提出 を 承認 に読み替える。
plan の 提出 は `implementing` を、verify の 提出 / 再提出 は `readying` を始める。
タイムラインは `currentEntries` を通さずに全部のエントリを読む今の作りを変えない。

#### 計画から立て直させるときの `board-planner`

`board-planner` の `revise-plan` は、「その否決より前の plan 承認」があれば実装の途中からの立て直しとみなし、前の実装の扱いを計画に書く。
plan を飛ばすカードには plan 承認のエントリが無いので、この判定に「plan を飛ばす宣言のカードでは、否決より前の plan 提出 / 再提出」を足す。

### Risks / Trade-offs

- **提出済みのカードに宣言を入れると、その場で通る。** 計画レビューで待っているカードに「計画レビューを飛ばす」を入れると、`plan 提出` が承認と読まれて実装中へ進む。
  人が自分で入れる印なので、承認を押したのと同じと受け止める。チェックボックスの説明文にそう書く
- **実装中のカードから宣言を外すと、計画レビューに戻る。** 承認のエントリが無いので、plan ゲートは `submitted` に戻る。
  人が「やはり読みたい」と決めたときの振る舞いとして正しいと考え、変えない
- **宣言は今の値で過去を読む。** タイムラインは今の `skipGates` で過去の 提出 を読むので、宣言を後から出し入れすると過去の区間の種類も変わる。
  今も着手の区間が今の宣言で決まっているのと同じ割り切りである
- **Draft の PR を出してから提出までのあいだは、計画レビューに見える。** 計画ファイルか Draft の PR があり plan ゲートが `none` なら計画レビューに立つ規則は変えない。
  `board-planner` が提出の前に止まると、plan を飛ばすカードでも計画レビューに残り、人の判断を待つ。取りこぼさないための保険として受け入れる
- **このカード自身は今の流れで進む。** `board-planner.md` と `board-decide` の手順書はメインのチェックアウトから読まれるので、マージまでは今の手順のままである

### Non-Goals

- verify を飛ばすカードの `board-worker` の流れを変えること（動作確認を頼まずに Ready にする道はそのまま）
- 宣言を書く入口を CLI に足すこと
- 宣言の出し入れを `## レビュー` に記録すること
- 計画レビューを飛ばすカードの計画を、提出の後に人へ知らせるしくみ

## 動作確認の手順

共有の DB を汚さないよう、`AI_BOARD_DB` でスクラッチパッドなどワークツリーの外の DB を指す。GitHub には繋がずに試す。
以下の `$DB` はその DB のパスである。メインのボードのサーバが動いていてポートがふさがるなら、先に止める。

1. `npm run build` の後に、`AI_BOARD_DB=$DB node dist/cli.js card create --title 試し --id try-skip < /dev/null` でカードを作る
2. `AI_BOARD_DB=$DB npm run dev` と `npm run dev:web` を起動し、ブラウザで次を見る
   - `try-skip` の詳細パネルのゲートの欄に「計画レビューを飛ばす」と「動作確認を飛ばす」の 2 つのチェックボックスがある
   - 「計画レビューを飛ばす」に印を入れても、カードはアイデアに留まる
3. `AI_BOARD_DB=$DB node dist/cli.js card submit try-skip --reason 試し` が「着手していない」旨で失敗し、`## レビュー` に何も増えない
4. 画面で着手を押すと計画提案中に入り、`AI_BOARD_DB=$DB node dist/cli.js status` の次の一手が `plan` になる
5. 3 と同じ `card submit` が通り、カードが計画レビューを通らずに実装中へ進む。`status` の次の一手が `implement` になる
6. `curl -s http://127.0.0.1:5673/api/board | jq '.cards[] | select(.id == "try-skip") | .timeline | map(.kind)'` が `["idea", "planning", "implementing"]` になる
7. 詳細パネルで「計画レビューを飛ばす」の印を外すと、plan ゲートが提出済みに戻って実装中から外れる
   （計画ファイルも Draft の PR も無いので、計画レビューではなく計画提案中に落ちる）。印を入れ直すと実装中に戻る
8. 実装中で `AI_BOARD_DB=$DB node dist/cli.js card hold try-skip --gate plan --reason 試し` は否決が無いので失敗する。
   画面の API で plan の否決を書く（`curl -s -X POST http://127.0.0.1:5673/api/cards/try-skip/reviews -H 'content-type: application/json' -d '{"gate":"plan","kind":"否決","reason":"試し"}'`）と計画提案中に落ち、次の一手が `revise-plan` になる。
   `card submit try-skip --resubmit --reason 試し` で実装中へ戻る
9. 起動したサーバを止める

## タスク

### 1. ゲートの読み替え

- [x] 宣言のあるゲートの 提出 / 再提出 を承認と読むように、ゲートの状態と古いエントリの区切りを変える。型と呼び出し側とテストを 1 つのコミットにまとめる
  - `review-log.ts`: `gateState` の「宣言があれば `approved`」をやめ、最新が 提出 / 再提出 で宣言があれば `approved` にする。
    `currentEntries` の区切りに宣言のあるゲートの 提出 / 再提出 を含め、`latestGateEntry` に `skipGates` を足す。docstring（97 行目付近、169 行目付近）を直す
  - 呼び出し側: `get-board.query.ts` の `latestReview` と `resolveHold` の呼び出し、`next-action.ts` の `HoldInput`（`skipGates` を足す）と `draftReverted` / `since`。
    `next-action.ts` の docstring（`judgeImpling` の「`approved` が宣言か人の承認か」、`draftReverted` の「エントリが 1 件も無いカード（plan を飛ばす宣言など）」）を新しい読み方に直す
  - テスト（`review-log.test.ts`）: 宣言ありで エントリ無し → none / 提出 → approved / 再提出 → approved / 否決 → rejected / 保留 → held。
    plan を飛ばすカードで verify 否決 → plan 否決 → plan 再提出 と並ぶと verify が none に戻る
  - テスト（`stage-resolver.test.ts`）: 宣言ありで未着手・エントリ無し → idea / 着手済み・エントリ無し → planning / plan 提出 → impling。
    未着手の下限が idea になる。今の「tasks が 0 件でも impling」「verify のエントリが外れない」「レビュー列に留まらない」を新しい読み方に合わせて直す
  - テスト（`next-action.test.ts`）: plan を飛ばす着手済みのカードに `plan` が選ばれる。「エントリが 1 件も無いカードは Draft に戻された時点で止まる」を plan 提出 のあるカードに直す
  - テスト（`card-cli.test.ts`）: 「skipGates に plan があれば承認が無くても --gate verify を受け付ける」を、plan 提出 の後に受け付ける形に直す

### 2. AI の plan の提出を着手したカードに限る

- [x] `card-cli.ts` の `runSubmit` で、plan ゲート（`--resubmit` を含む）は `startedAt` が null のカードでは失敗させ、何も追記しない。使い方の文言と docstring を直す
  - テスト: 未着手のカードの `submit` が 1 になり本文が変わらない / 着手済みなら 0。plan を飛ばす未着手のカードでも 1。既存の `submit` のテストは着手済みのカードで試すように直す

### 3. タイムライン

- [x] `stage-timeline.ts` で、着手は宣言によらず `planning` を始め、宣言のあるゲートの 提出 / 再提出 は 承認 と同じ区間を始めるようにする
  - テスト: plan を飛ばす: 着手 → plan 提出 で `idea` / `planning` / `implementing`。verify を飛ばす: verify 再提出 で `readying` が始まる。今の「着手から implementing が始まり、planning が無い」を直す

### 4. 判断のボタン

- [x] `dashboard-sections.ts` の `decisionsFor` で、宣言のあるゲートの承認 / 否決を隠すのをやめる。`DecisionCard` から `skipGates` を外し、docstring を直す
  - テスト: plan を飛ばすカードが実装中で止まると「計画から立て直させる」が出る / verify を飛ばすカードが Draft に戻されると「実装を直させる」が出る

### 5. 画面

- [x] `SkipGateField.tsx` に「計画レビューを飛ばす」のチェックボックスを足す（`withSkipGate` で `plan` を出し入れし、他の宣言は保つ）。
      説明文に「印を入れると、AI が計画を提出した時点で計画レビューを通ったものとみなします。提出済みのカードはすぐに実装中へ進みます」と書く。コンポーネントの docstring を直す

### 6. ループとスキル

- [x] `.claude/agents/board-planner.md` の `revise-plan` で、立て直しの判定に「plan を飛ばす宣言のカードでは、否決より前の plan 提出 / 再提出」を足す
- [ ] `.claude/skills/board-decide/SKILL.md` に「計画レビューを飛ばす」の操作（表と curl の例）を足し、説明の起動の言葉に足す。ハードルールの「`skipGates` の `plan` に触れない」を外す

### 7. ドキュメント

- [ ] `README.md` を直す: 詳細パネルのゲートの欄（39 行目付近）、判断のボタンの注記（54 行目付近、185 行目付近）、スキップの節（新しい読み方と 2 つのチェックボックス、着手と提出で進むこと）、誰が動かせるかの表の実装中の行、`board-decide` のできること
- [ ] `docs/architecture.md` を直す: ゲートの状態（`gateState` の読み替え、`currentEntries` の区切り）、判断のボタンの注記、`skipGates` を画面から書く入口
- [ ] `docs/specs/` を直す
  - `card-gate-skip`: 要件を「宣言のあるゲートでは 提出 / 再提出 を通過済みとして扱う」に改め、plan の宣言の入口を足す。
    シナリオ「計画レビューを飛ばす」「スキップしたカードは待ちの列に滞留しない」を、未着手ならアイデア・着手で計画提案中・提出で実装中・否決で計画提案中、に置き換える
  - `card-review-log`: 前のゲートの承認に、宣言のあるゲートの 提出 / 再提出 を含める。「plan を飛ばすカードでは verify の記録が外れない」を直し、立て直しのシナリオを足す
  - `board-timeline`: 表の `implementing` の始まりを「plan 承認（plan を飛ばすカードは plan 提出 / 再提出）」に、`readying` に verify を飛ばすカードの 提出 / 再提出 を足す
  - `board-hold`: 「動作確認を飛ばすカードの PR が Draft に戻された」の条件を新しい読み方に合わせる
  - `card-review-authority`: AI の plan 提出は着手したカードにだけ書けることと、宣言のあるゲートでは AI の提出が人の承認とみなされることを足す

### 8. 確かめる

- [ ] 品質ゲートと `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DB` の別の DB で試す
