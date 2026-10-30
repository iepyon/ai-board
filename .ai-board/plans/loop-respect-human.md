# 人が止めたり Draft に戻したりしたカードを、ループが押し進めないようにする

## この計画で使う言葉

- **ループ / 監視役 / 作業者**：`/board-loop` の監視役が `ai-board status --json` の `next` を読み、作業者（board-worker）にカード 1 枚の 1 手だけをさせる。
  何を選ぶかは `src/board/services/next-action.ts` の `pickNextAction` が決める
- **`waiting`**：`status` が出す「人の番のカード」の一覧。今は 計画レビュー / 動作確認 / PR中 のカードと、AI の列にいるのにループが手を出さないカード（`findStuckCards`）が入る
- **ゲートの状態**：`## レビュー` のゲートごとの最新エントリで決まる（`gateState`）。`none` / `submitted` / `approved` / `rejected` の 4 つ
- **保留（新しく足す）**：作業者が「この手は自分では進められない」と判断して手を止めたことを、`## レビュー` に残すエントリ。AI が書く
- **止まっているカード（新しく足す）**：AI の列（計画提案中 / 実装中）にいるが、人の判断を待っているカード。ステージは AI の列のまま、判断待ちの区画に出す

## 提案

### Why

`verify-gate`（PR #37）の AI レビューで、設計の判断が要るとして残した指摘が 2 件ある。
どちらも、ループが人の判断や操作より自分の規則を優先して、同じ手を出し続ける形である。

1 件目は、動作確認で否決されたカードである。
作業者は否決の理由を読んで直すが、直すには大きすぎると判断すると、何も変えずに止まって報告する。
しかし作業者が止まったことはどこにも残らない。
`next-action.ts` は「verify の最新が否決」だけを見て `revise-impl` を選ぶので、次の周も同じカードに同じ手を渡し、作業者はまた止まる。
ループは 1 周に 1 手しか進めないので、後ろのカードは人が手を入れるまで動かない。
しかも人には、このカードを計画から立て直させる入口が無い。実装中 のカードには判断のボタンが出ないからである。

2 件目は、動作確認を承認した後のカードである。
AI が PR を Ready にした後で、人が見直して Draft に戻すことはありうる。
Draft に戻すと PR中 の規則が外れてカードは 実装中 に落ち、`next-action.ts` は「verify が承認済み」だけを見て `ready` を選ぶ。
作業者は計画が archive 済みなのを見て「前の周で `gh pr ready` だけが失敗した」と読み、すぐに Ready にし直してしまう。
動作確認を飛ばす宣言のカードでも同じで、`implement` が同じ回復の道を通って Ready にし直す。

### What Changes

使う人から見た変化は次のとおり。

- 作業者が否決を直しきれずに止まると、カードは判断待ちの区画に出る。理由（作業者が書いた、なぜ止まったか）が読める。
  ループはそのカードを飛ばして、後ろのカードへ進む
- 止まっているカードの詳細パネルにボタンが出る。
  「実装を直させる」（verify の否決。直し方の手がかりを理由に書く）、「計画から立て直させる」（plan の否決）、「中止する」の 3 つである
- 「計画から立て直させる」を押すと、カードは 計画提案中 に戻り、ループは `revise-plan` で計画を直させる。
  計画をもう一度承認すると、前の動作確認の記録は数えられず、ループはタスクを倒す `implement` から始め直す
- 動作確認の画面（動作確認 の列のカード）にも「計画から立て直させる」を出す。動かした時点で計画からやり直すべきと分かることがあるためである
- 人が PR を Draft に戻すと、カードは判断待ちの区画に「PR が Draft に戻された」として出て、ループは Ready にし直さない。
  人が GitHub で Ready に戻すか、ボタンで否決・中止すると、止まりが解ける

中の仕組みの変化は次のとおり。

- `## レビュー` の種別に、AI が書く `保留` を足す。ゲートの状態に `held` を足す
- CLI に `ai-board card hold <id> --gate <plan|verify> --reason <text>` を足す。作業者は直しきれないときにこれを書いてから止まる
- ゲートの状態を出すとき、`verify` のエントリのうち `plan` の最新の承認より前のものを数えない
- GitHub の PR から、最後に Draft へ戻された時刻（`convert_to_draft` のイベント）を引く
- 「止まっているか」を `BoardCard.hold` としてサーバで判定し、ループの選択・`status` の `waiting`・画面の区画が同じ値を読む。
  今の `findStuckCards`（計画を提出したのに成果物が見えない）もここへまとめる

### Impact

- 型: `src/cards/models/review.ts`（`REVIEW_KINDS` に `保留`、`GateState` に `held`）、`src/board/models/mr-state.ts`、`src/board/models/board-card.ts`、`src/web/types.ts`
- ゲート: `src/cards/services/review-log.ts`（`gateState` の switch、前のゲートの承認より古いエントリを数えない規則）
- ステージ導出: `src/board/services/stage-resolver.ts` は規則を変えない。`toFacts` が新しいゲートの状態の出し方を使うだけ
- 次の一手: `src/board/services/next-action.ts`、`src/board/usecases/queries/get-board.query.ts`、`src/board/cli/status-cli.ts`
- GitHub: `src/board/services/github-client.ts`
- CLI / API: `src/cards/cli/card-cli.ts`（`hold`）、`src/cards/models/schemas/card.schema.ts`（人の API が AI の種別を受け付けない）
- 画面: `src/shared/dashboard-sections.ts`、`src/web/components/detail/ReviewActions.tsx`、判断待ちの区画のカード
- 手順書とドキュメント: `.claude/agents/board-worker.md`、`.claude/skills/board-loop/SKILL.md`、`CLAUDE.md`、`README.md`、`docs/specs/board-stages/spec.md`、`docs/specs/card-review/spec.md`

## 設計

### Decisions

#### 1 枚のカードは新しい流れをどう通るか

「カードを絞り込めるようにする」が 動作確認 で否決されたとしよう。

1. 監視役が `revise-impl` を選び、作業者が否決の理由を読む。直すには検索の仕組みから作り直す必要があり、1 手に収まらないと判断する
2. 作業者は何も直さず、`ai-board card hold <id> --gate verify --reason "<なぜ止まったか、何を決めてほしいか>"` を書いて止まる
3. カードの `## レビュー` に `verify 保留` が増える。verify の状態は `held` になり、ステージは 実装中 のまま、`hold` が立つ
4. 次の周の `status` は、このカードを `waiting` に入れて `next` に選ばない。後ろのカードが進む
5. 人は判断待ちの区画で理由を読み、「計画から立て直させる」を押す。`## レビュー` に `plan 否決` が増え、カードは 計画提案中 に落ちる
6. 監視役が `revise-plan` を選び、作業者は計画を直して再提出する。カードは 計画レビュー へ進む
7. 人が計画を承認すると、カードは 実装中 に戻る。verify の否決と保留は plan の承認より古いので数えず、verify の状態は `none` になる。監視役は `implement` を選ぶ

5 で「実装を直させる」を押せば `verify 否決` が増えて `hold` が外れ、`revise-impl` からやり直す（人が理由に直し方の手がかりを足す想定）。
「中止する」を押せば、ほかのカードと同じく中止の区画に寄る。

#### 止まったことをどこに残すか

`## レビュー` に AI が書く 3 つ目の種別 `保留` として残す。

ほかの置き場は次の理由で採らない。

- カード本文の `## 探索メモ`：自由記述で、導出の入力にしないと決めている
- PR のコメント：作業者のコメントは人の `gh` のログインで書かれ、人のコメントと見分けが付かない。`latestNoteAt` の「人が書いた最新のコメント」も狂う
- `verify 提出` で代える案：カードが 動作確認 の列に上がり、「承認」を押すと何も直っていないまま `ready` に進む。列の意味（動かして確かめる番）とも合わない

`保留` はゲートの最新エントリとして読む。人が後から何か書けば（否決・承認・中止）それが最新になり、保留は自然に外れる。
保留を解くための専用のエントリは要らない。

ステージの規則は変えない。verify が `held` のとき、規則 3（verify が `submitted`）は外れ、規則 4（plan 承認済み）で 実装中 になる。
plan が `held` のとき（計画を直しきれずに止まったとき）、規則 5（plan が `none` / `submitted`）は外れ、規則 6 で 計画提案中 になる。
どちらも AI の列のまま、`hold` だけが立つ。

書き込み境界は「AI が `## レビュー` に書いてよいのは 提出 / 再提出 / 保留」に広がる。
承認 / 否決 / 中止を人だけが書く決まりは変えない。
人の API（`POST /api/cards/:id/reviews`）は 承認 / 否決 / 中止 だけを受け付けるように絞る。
今のスキーマは docstring で「提出 / 再提出は受け付けない」と書きながら、`REVIEW_KINDS` 全部を通しているので、あわせて直す。

#### 計画へ差し戻す入口

導出は今のままで足りる。
plan 承認済みのカードに `plan 否決` を書くと、plan の状態は `rejected` になり、規則 3〜5 が外れて規則 6 の 計画提案中 に落ちる。
`judgePlanning` は `revise-plan` を選ぶ。専用の規則も専用のエントリも足さない。

足りないのは 2 つである。

- **ボタン。** 判断のボタンは `GATE_OF_STAGE` のある列（計画レビュー / 動作確認）にしか出ない。
  止まっているカードと 動作確認 のカードに「計画から立て直させる」を出す。
  どのカードにどのボタンを出すかは `src/shared/` の純関数（`decisionsFor`）に置いてテストする（`src/web/` はテストの対象外のため）
- **計画をもう一度承認した後の verify の状態。** 何もしないと、承認後も古い `verify 否決` や `verify 保留` が verify の最新エントリのままで、ループは `revise-impl` や止まりを返す。
  そこで「後ろのゲートは、前のゲートの最新の承認より前のエントリを数えない」とする。ゲートの順は `REVIEW_GATES`（`plan` → `verify`）の並びで決める。
  計画を承認し直したなら、前の計画に対する動作確認の判断はもう効かない、という意味である。
  通常の流れでは verify のエントリはすべて plan の承認より後にあるので、振る舞いは変わらない。
  plan を飛ばす宣言のカードは plan の承認エントリが無いので、何も外れない

この規則は `review-log.ts` に `gateStates(entries, skipGates)`（ゲートの状態をまとめて返す）として置き、`stage-resolver.ts` の `toFacts` と CLI の `planApproved` はこれを使う。
`latestGateEntry` も同じ規則で選ぶ（判断待ちの区画に古い verify の否決が出ないように）。

作業者が `revise-plan` で計画を直すとき、ブランチには前の実装が残り、計画のタスクには `[x]` が付いている。
手順書に「計画から立て直すときは、作り直すタスクの `[x]` を外すか新しいタスクを足し、残す実装と捨てる実装を計画に書く」と足す。

#### Draft に戻したことをどう読むか

`mrState.draft` では見分けられない。
動作確認を頼むあいだも PR は Draft なので、「まだ一度も Ready にしていない」と「人が Draft に戻した」が同じ値になる。

そこで GitHub の `issues/{n}/events` から `convert_to_draft` のイベントを引き、最新の時刻を `MrState.convertedToDraftAt` として持つ。
引くのは PR が open かつ Draft のときだけにする（Ready の PR とマージ済みの PR では使わない）。
ほかの一覧と同じく `gh api --paginate` で全ページ引いて最大値を取る。

「止まっている」とみなすのは、実装中のカードで `convertedToDraftAt` がカードの最新のレビューエントリより新しいときである。
人の判断より後に PR が Draft に戻された、という意味になる。

- 作業者が PR を作った時点の Draft はイベントにならない（作成時の Draft は `convert_to_draft` を残さない）
- 計画レビューの前に誰かが Draft に戻していても、その後の plan 承認のほうが新しいので止まらない
- 人が止まりを解くには、GitHub で Ready に戻す（PR中 へ進む）か、ボタンで否決・中止する（そのエントリが新しくなる）

動作確認を飛ばす宣言のカードも、`implement` の手で Ready にした後に Draft に戻されれば同じく止まる。
判定は verify の状態より前に見るので、`ready` と `implement` の両方を止められる。

これで作業者の手順書にある「計画が archive 済みなら `gh pr ready` だけをやり直す」回復の道も安全になる。
人が戻した場合はループがそもそも手を選ばないので、そこへ来るのは本当に `gh pr ready` だけが失敗したときに限られる。

#### 止まりをどこで判定し、誰が読むか

`next-action.ts` の判定（今の `judge`）を「手か、止まりか、なし」を返す純関数として残し、ボードの組み立て（`get-board.query.ts`）で `BoardCard.hold: { reason, since } | null` に載せる。
読むのは 3 か所である。

- `pickNextAction`：`hold` のあるカードを選ばない
- `status` の `waiting`：判断待ちの区画（`groupBySection` の inbox）をそのまま使う。`findStuckCards` を別に足し込むのはやめる（重複して出るため）
- 画面：`groupBySection` が `hold` のあるカードを inbox へ振り分け、`waitingSince` は `hold.since` を使い、`awaitsDecision` を真にする

今の「計画を提出したのに計画ファイルも Draft の PR も見えない」止まりもここへまとめる。
これまでは `status` にしか出なかったが、画面の判断待ちにも出るようになる（ボタンは中止だけ）。

`hold.reason` は人が何をすればよいかを書く。

| 止まり                         | `reason`                                                                                               | ボタン                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| verify 保留                    | `作業者が直しきれずに止まった。実装を直させるか、計画から立て直させるか、中止するかを選んでください`   | 実装を直させる / 計画から立て直させる / 中止 |
| plan 保留                      | `作業者が計画を直しきれずに止まった。否決の理由を足して直させるか、中止するかを選んでください`         | 計画を直させる / 中止                        |
| PR が Draft に戻された         | `判断の後に PR #n が Draft に戻された。Ready に戻すか、実装を直させるか、計画から立て直させてください` | 実装を直させる / 計画から立て直させる / 中止 |
| 提出済みなのに成果物が見えない | 今の文言のまま                                                                                         | 中止                                         |

保留のエントリの本文（作業者が書いた理由）は、今の判断待ちのカードと同じく `latestReview` として区画に出る。

`hold` は表示と選択のための派生値で、どこにも保存しない。ステージでもない。
ステージは「工程のどこにいるか」、`hold` は「その工程で誰を待っているか」で、軸が違う。

### Risks / Trade-offs

- **書き込み境界が広がる。** AI が `## レビュー` に書ける種別が 1 つ増える。
  ただし `保留` はゲートを先へ進めない（どの規則も `held` で前へ進まない）ので、AI が自分の判断で工程を進める入口にはならない
- **GitHub への問い合わせが増える。** open かつ Draft の PR ごとに `issues/{n}/events` を 1 回引く。カード単位の問い合わせという今の方針の範囲に収まる
- **作業者が保留を書き忘れる。** 手順書に書いても、作業者が書かずに止まれば今と同じく同じ手を選び続ける。
  ゲートが通らない、未コミットの変更が残っている、といった止まり方も今のまま（下の Non-Goals）
- **計画を承認し直すと、前の動作確認の判断が消えて見える。** エントリは本文に残り、`card show` で読める。数えないだけである
- **このカード自身は今の流れで進む。** 作業者の手順書はメインのチェックアウトから読まれるので、`hold` を使う手順はマージ後から効く

### Non-Goals

- ゲートが通らない、未コミットの変更が残っている、といった作業者の止まり方を `hold` で残すこと。これらはワークツリーを人が直す話で、判断のボタンでは解けない
- 計画レビューの列（計画を読む画面）に「計画から立て直させる」を出すこと。そこでは今の否決が同じ意味である
- PR中 のカードを計画へ差し戻すこと。PR が Ready のあいだは規則 2 が勝つので、まず Draft に戻してもらう（戻せば上の止まりになり、ボタンが出る）
- 監視役が `hold` を書くこと。書くのは作業者だけにする

## 動作確認の手順

共有の DB を汚さないよう、`AI_BOARD_DB` で別の DB を指す。人の操作（着手・承認・否決）はこの別の DB に対してだけ、API か画面で行う。

1. `npm run build` の後、`export AI_BOARD_DB=$(mktemp -d)/board.db` を設定し、`npm run dev` と `npm run dev:web` を起動する
2. `node dist/cli.js card create --title 試し --id try-hold` でカードを作り、画面で「着手」を押す。
   このカードには計画ファイルも PR も無いので、計画レビューの列に上がらずボタンが出ない。人の判断は API で書く（`R=localhost:5673/api/cards/try-hold/reviews`）
   - `card submit try-hold` → `curl -X POST $R -H 'content-type: application/json' -d '{"gate":"plan","kind":"承認"}'`
   - `card submit try-hold --gate verify` → 同じく `{"gate":"verify","kind":"否決","reason":"検索が遅い"}` を書く
3. `node dist/cli.js card hold try-hold --gate verify --reason 直すには大きすぎる` を実行する
   - `node dist/cli.js status` で、`try-hold` が判断待ちに出て、`次の一手` に選ばれない
   - 画面の判断待ちの区画に `try-hold` が出て、保留の理由と「実装を直させる」「計画から立て直させる」「中止する」が見える
4. 「計画から立て直させる」に理由を書いて押す
   - カードが 計画提案中 に戻り、`status` の `次の一手` が `revise-plan try-hold` になる
5. `card submit try-hold --resubmit` → 2 と同じく API で `{"gate":"plan","kind":"承認"}` を書く
   - カードが 実装中 に戻り、`status` の `次の一手` が `implement try-hold`（`revise-impl` ではない）になる
6. 動作確認 の列のカードの詳細パネルに「計画から立て直させる」が出ることを見る（2 と同じ手順で verify 提出まで進めたカードで）
7. `card hold` が人の API から書けないこと: `curl -X POST localhost:5673/api/cards/try-hold/reviews -H 'content-type: application/json' -d '{"gate":"verify","kind":"保留","reason":"x"}'` が 400 を返す

PR を Draft に戻す道は、本物の PR が要るので別の DB だけでは通せない。
単体テスト（GitHub のイベントの読み取り、止まりの判定）で確かめ、通しで見るなら、使い捨てのブランチで PR を作り、`gh pr ready` の後に `gh pr ready --undo` で Draft に戻して `status` の `waiting` に出ることを見る。

## タスク

### 1. ゲート

- [x] `REVIEW_KINDS` に `保留`、`GateState` に `held` を足し、受け止める箇所を 1 つのコミットにまとめる
  - `gateState` の switch、`judgeImpling` / `judgePlanning`（この時点では `held` を「止まり」として返す）、web の型
  - 人の API のスキーマを 承認 / 否決 / 中止 だけに絞る。e2e テストに「提出 / 保留 は 400」を足す
  - テスト: verify の最新が 保留 → `held`、その後に人の否決 → `rejected`。ステージは verify `held` で 実装中、plan `held` で 計画提案中
- [x] `gateStates` を足し、後ろのゲートは前のゲートの最新の承認より前のエントリを数えない。`toFacts`・`planApproved`・`latestGateEntry` をこれに寄せる
  - テスト: plan 承認 → verify 否決 → verify 保留 → plan 否決 → plan 再提出 → plan 承認 の順で、ステージが 実装中・計画提案中・計画レビュー・実装中 と動き、最後の verify が `none`
  - テスト: plan を飛ばす宣言のカードでは verify のエントリが外れない

### 2. CLI

- [x] `ai-board card hold <id> --gate <plan|verify> --reason <text>` を足す。理由は必須。verify は plan 承認前なら拒む（`submit --gate verify` と同じ）。使い方の文言とテスト

### 3. GitHub

- [x] `MrState` / `BoardCardMr` に `convertedToDraftAt` を足し、open かつ Draft の PR だけ `issues/{n}/events` を `--paginate` で引いて `convert_to_draft` の最新時刻を入れる
  - テスト: イベントが無い → null、複数 → 最大値、Ready / マージ済みの PR では問い合わせない
  - 作成時から Draft の PR に `convert_to_draft` が残らないことを、このカードの PR の `issues/{n}/events` で確かめる（残るなら判定の基準を見直す）

### 4. 止まりの判定

- [x] `next-action.ts` に止まりの判定（verify 保留 / plan 保留 / Draft に戻された / 提出済みなのに成果物が見えない）を集め、`BoardCard.hold` を `get-board.query.ts` で載せる。`pickNextAction` は `hold` のあるカードを選ばない
  - Draft に戻された判定は verify の状態より前に見る（`ready` と、飛ばす宣言の `implement` の両方を止める）
  - テスト: 止まったカードを飛ばして後ろのカードを選ぶ / Draft に戻された時刻が最新のエントリより古ければ止まらない / 人が否決を書くと止まりが外れて `revise-impl`
- [x] `status` の `waiting` を inbox から作り、`findStuckCards` の足し込みをやめる。`status-cli.test.ts` で、止まったカードが `waiting` に 1 度だけ出て `working` に出ないことを確かめる

### 5. 画面

- [x] `dashboard-sections.ts`: `hold` のあるカードを inbox へ、`waitingSince` は `hold.since`、`awaitsDecision` を真に。どのボタンを出すかを返す `decisionsFor` を足してテストする
  - inbox への振り分けと `waitingSince` は、`status` の `waiting` を inbox から作るのに要るので 4 で済ませた。残りは `awaitsDecision` と `decisionsFor`
  - `awaitsDecision` は `decisionsFor` が 1 つでもボタンを返すかで決める。止まりの種類は `hold` に持たせず、ステージと `gates.plan` から見分ける。
    飛ばす宣言のあるゲートの承認 / 否決は出さない（否決を書いても差し戻しにならず、verify を飛ばすカードでは何も直らないまま Ready にし直されるため）
- [x] `ReviewActions` を `decisionsFor` で描く（「実装を直させる」「計画から立て直させる」「計画を直させる」は理由必須）。判断待ちの区画のカードに `hold.reason` を出す

### 6. ループ

- [ ] `.claude/agents/board-worker.md`: `revise-impl` で直しきれないときは `ai-board card hold <id> --gate verify --reason` を書いてから止まる（`revise-plan` も同じく `--gate plan`）。
      計画から立て直すときのタスクの扱いを `revise-plan` に足す。ハードルールの「`## レビュー` に書いてよいもの」に 保留 を足す
- [ ] `.claude/skills/board-loop/SKILL.md`: `waiting` に止まっているカードが入ることと、ハードルールの書き込める種別を直す

### 7. ドキュメント

- [ ] `CLAUDE.md`（`card hold` の使い方、書き込み境界、ゲートの状態、やってはいけないこと）、`README.md`、`docs/specs/board-stages/spec.md`、`docs/specs/card-review/spec.md` を直す

### 8. 確かめる

- [ ] 品質ゲートと `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DB` の別の DB で試す
