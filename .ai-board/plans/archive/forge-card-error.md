# 1 枚の PR が引けないときは、そのカードだけを止め、ボードとループ全体は止めない

## 人に判断してほしいこと

- **失敗の説明に、GitHub の応答の本文を載せるか。** カードは「HTTP のステータスと本文の 1 行を出す」としている。
  今の `cli-runner.ts` は、`gh` の stderr に資格情報が混じりうるので本文を載せず、`(HTTP nnn)` の数字だけを抜き出している。
  既定: 本文は載せない。載せるのは、カード ID・PR 番号（またはブランチ）・問い合わせ先（`pulls/68` のようにクエリを除いた道）・HTTP のステータスまで。
  例: `PR #68 の取得（pulls/68）が HTTP 422 で失敗した`。
  載せる場合は、stderr の `gh: <文> (HTTP nnn)` の形の行だけを、長さを切って載せる（それ以外の行は捨てる）
  - → 回答（2026-11-05、plan 承認）: 失敗の説明に GitHub の応答の本文は載せない（既定のまま）

## 提案

### Why

2026-11-03、`gh api repos/iepyon/ai-board/pulls/68` が HTTP 422 を返し続けた。ほかの PR は引けていたのに、ループ全体が止まった。

- `ForgePoller.refresh` は、カードごとの失敗を `firstError` に拾い、1 件でもあれば接続の状態をまるごと `error` にする
- `status` は `forge.status` が `connected` でないと `next` を `null` にし、`ai-board decide` も承認 / 否決 / 中止・着手 / 着手を戻すを拒む
- エラーの文言は「gh の終了コード 1 で失敗した」だけで、どのカードのどの問い合わせかが分からない

`next` を止めるのは、PR の状態が引けないと 計画レビュー / PR中 のカードが手前の AI の列に落ちて見え、AI が人の番のカードに手を出すおそれがあるためである。
この安全側の考えは保ったまま、止める範囲を、引けなかったカードだけに絞る。

### What Changes

使う人から見た変化は次のとおり。

- 1 枚の PR だけが引けないとき、GitHub の接続は「接続済み」のままになる。ほかのカードは今までどおり導出され、`next` も出る
- 引けなかったカードは止まり（`hold`）になり、判断待ちの区画（`status` の `waiting`）に出る。理由は次の形になる。
  `PR の状態を引けない（PR #68 の取得（pulls/68）が HTTP 422 で失敗した）。時間を置いても続くなら、GitHub で PR を確かめてください`
- 止まったカードには判断のボタンを出さず、`ai-board decide` も、そのカードの承認 / 否決 / 中止・着手 / 着手を戻すを拒む（全体のエラーのときと同じ理由）
- 引けなかったカードは、前に引けた PR の状態（控え）があればそれで列を決める。手前の AI の列に落ちない
- 全体のエラー（`forge.status` が `error`）は、`gh` が無い・ネットワークが切れた・認証や上限で断られた、など、どのカードにも効く失敗のときだけにする。
  その文言にも、どのカードのどの問い合わせかを出す
- 次の周で引ければ、止まりはひとりでに外れる

### Impact

- 取得: `src/board/services/forge-client.ts`（失敗の型と、全体かカードかの見分け）、`src/board/services/github-client.ts`（失敗に問い合わせ先と HTTP のステータスを載せる）
- ポーリング: `src/infrastructure/forge-poller.ts`（カードごとの失敗を持つ）、`src/board/services/mr-state-provider.ts`（カードの失敗を読む口）
- 止まり: `src/board/services/next-action.ts`（`resolveHold` と `CardHold`）、`src/board/usecases/queries/get-board.query.ts`、`src/shared/dashboard-sections.ts`（`decisionsFor`）、`src/web/types.ts`（`CardHold` の写し）
- 人の判断の CLI: `src/board/cli/decide-cli.ts`
- ドキュメント: `docs/architecture.md`（止まり・GitHub の取得）、`docs/adr/0006-ai-review-entries-and-hold.md`（止まりの種類）、`.claude/skills/board-loop/SKILL.md`（止まりの列挙）、`README.md`（止まりの説明があれば）
- ステージの導出（`stage-resolver.ts`）・API の道・データ用ブランチの形の版: 変わらない

## 設計

### Decisions

#### 失敗を、全体とカードに分ける

- `forge-client.ts` に、取得の失敗を表す `ForgeRequestError`（`Error` を継いだもの）を足す。持つのは次のとおり
  - `endpoint`: 問い合わせ先の道（`pulls/68`。`?` から後ろのクエリは落とす。ブランチ名はクエリに入るので載らない）
  - `httpStatus`: `CliError` の `httpStatus`（取れなければ null）
  - `scope`: `'global'` か `'card'`
- 見分けは純関数 `failureScope(error: CliError): 'global' | 'card'` にする
  - `global`: `NotInstalled`、`Failed` で `httpStatus` が null（ネットワークの断・タイムアウト・gh の内部の失敗）、401、403、429、5xx
  - `card`: それ以外の `Failed`（400・409・410・422 など）と `InvalidJson`
  - 404 は今どおり「PR が無い」（null）で、失敗にしない
- `github-client.ts` の `get` / `getAll` は、`unwrap` の代わりに、失敗を `ForgeRequestError` にして投げる。メッセージは `<endpoint> が HTTP <n> で失敗した`（ステータスが無ければ今の `describeCliError` の文）

#### ポーラーがカードごとの失敗を持つ

- `ForgePoller` に `failures: Map<CardId, ForgeCardFailure>` を足す。`ForgeCardFailure` は `{ message, since }`
  - `message`: `PR #<iid> の取得（<endpoint>）が…` か、PR 番号が無ければ `ブランチ <branch> の PR の解決（<endpoint>）が…`
  - `since`: そのカードが失敗し始めた時刻。失敗が続くあいだは最初の時刻を保ち、引けたら消す（プロセスの中だけで持ち、控えには書かない）
- `refresh` では、カードの失敗が `scope: 'card'` なら `failures` に入れて次のカードへ進む。
  `scope: 'global'` の失敗、または `ForgeRequestError` でない例外が 1 件でもあれば、今どおり接続の状態を `error` にする。
  そのときの `message` は `<カード ID>: <カードの失敗の文>` にする
- 失敗したカードのキャッシュ（前に引けた控え）は消さずに残す（今もそうなっている）。`get` はそれを返す
- `failures` の中身が変わったら（足された・消えた）、`changed` にして `onUpdate` を呼ぶ
- 問い合わせの対象から外れたカード（`forgetUntracked`）の失敗も消す
- `MrStateProvider` に `failure(cardId): ForgeCardFailure | null` を足す。`disabledMrStateProvider` / `unavailableMrStateProvider` は常に null

#### 止まりにする

- `CardHold` に `kind: 'decision' | 'forge'` を足す。今の 3 つの止まりは `decision`（人の判断かボタンで解く）、新しい止まりは `forge`（時間が経てば解ける）
- `HoldInput` に `mrFailure: ForgeCardFailure | null` を足す。`resolveHold` は、中止でなく、列が アイデア / マージ済み 以外で、`mrFailure` があれば、ほかの止まりより先に
  `{ kind: 'forge', reason: HOLD_REASONS.forgeFailed(message), since }` を返す
- `get-board.query.ts` は、カードごとに `mrProvider.failure(card.id)` を `resolveHold` に渡す。そのカードの `mrKnown` は、全体の `mrKnown` かつ失敗が無いとき、にする
- `decisionsFor` は、`hold.kind` が `forge` なら空を返す（列が PR の状態に依るので、押せるボタンを決められない）。画面と `status` の `waiting[].decisions` が同じになる
- `ai-board decide` は、承認 / 否決 / 中止・着手 / 着手を戻すで、対象のカードの `hold.kind` が `forge` なら拒む。文言は `GitHub から PR の状態を引けないので、<操作>は書けません（<理由>）`。
  飛ばす宣言と並べ替えは今どおり拒まない
- `pickNextAction` は変えない（止まりを飛ばす今の形のまま、そのカードを選ばない）

### 仮定

- **全体かカードかは、失敗の種類で見分ける。** 全カードが失敗したら全体、では、カードが 1 枚しか無いときに見分けられない（カードの論点）。
  認証・上限・ネットワーク・サーバの失敗はどの PR でも同じに起きるので全体に、PR の中身に依る 4xx はカードに寄せる。
  5xx を全体にするのは、GitHub の障害で全カードが一度に止まりになり、判断待ちが埋まるのを避けるため
- **判断待ちの区画に出す。** 専用の区画は作らない。止まりは「AI が進められず、人が見るもの」で、`waiting` は人が読む一覧である。
  ボタンが出ない止まりは、今も「提出済みなのに成果物が見えない」（中止だけ）に近い形がある
- **前に引けた控えで列を決める。** 控えが古くても、AI が人の番のカードを進めることはない（そのカードは止まりで、`next` に選ばれない）。
  控えが無い（初めて引くときに失敗した）カードは、手前の列に見えることがあるが、止まりなので `next` には選ばれない
- **`since` はプロセスの中だけで持つ。** `ai-board status` は呼ぶたびに新しいプロセスなので、そのときの時刻になる。区間の時間（`timeline`）には使わないので、ずれても困らない
- **手順書の版は上げない。** `SKILL.md` の変更は止まりの列挙に 1 つ足すだけで、ループの振る舞い（止まりを飛ばす）は変わらない
- 探索メモは無い

### 退けた代案

- **全カードが失敗したときだけ全体のエラーにする:** カードが 1 枚のときに、1 枚の PR の 422 でループ全体が止まる今の形に戻る
- **引けなかったカードは控えをそのまま使い、止まりにしない:** 控えが古いと、人が PR に書いた指摘（`fix-pr`）や Draft への戻しを見落としたまま AI が進める
- **止まりの専用の区画を作る:** 区画と画面の部品が増える。件数は少なく、判断待ちの一覧で足りる
- **控えに失敗を書いて、次のプロセスへ持ち越す:** 控えの形（データ用ブランチの外の `cache/`）を変えることになる。次の周でもう一度引けば同じ失敗が分かる
- **`forge-poll-budget`（引き直しを減らす）と一緒にやる:** 別のカードに残す。今回の変更は、問い合わせの回数を変えない

### Risks / Trade-offs

- 5xx を全体にするので、1 枚の PR だけが 5xx を返し続けると、今どおりループ全体が止まる。そのときも文言でどのカードかは分かる
- 控えの無いカードが手前の列に見えることがある。止まりの理由で、PR の状態を引けていないことが分かる
- `src/web/types.ts` の `CardHold` は手で写した型なので、`kind` を写し忘れても型検査では気付けない（`share-api-types` のカード）。このカードで写す

### Non-Goals

- 問い合わせの回数を減らすこと（`forge-poll-budget`）
- 止まりを上限で人に回すこと（`loop-retry-limit`）
- 画面の新しい部品。止まりは今の判断待ちの区画と理由の表示で見せる
- ステージの導出の変更

## 探索メモとの対応

- 探索メモなし

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/forge-card-error`（以下 `$WT`）。`rules.md` の「動かして確かめるとき」のとおり、スクラッチパッドの bare リポジトリを `origin` にした clone（`$S/data`）を `AI_BOARD_DATA` で指す。
本物の GitHub は使わず、`$S/bin/gh` に偽の `gh`（引数を見て、決まった応答と終了コードを返すシェル）を置き、`PATH="$S/bin:$PATH"` で走らせる。
`$S/data` の根に `config.yaml`（`github:` に適当な owner / repo）を置く。

1. 1 枚だけが 422 のとき、ほかのカードの `next` が出る
   - コマンド: カード `a`（`--id a`、着手済みで計画提案中）と、ブランチ `b` を紐付けたカード `b` を作る。偽の `gh` は `pulls?head=…:b` に `gh: … (HTTP 422)` を stderr に出して 1 で終わり、ほかは空の配列を返す。
     `PATH="$S/bin:$PATH" AI_BOARD_DATA=$S/data node $WT/dist/cli.js status --json --only next,waiting,forge`
   - 期待: `forge.status` が `connected`、`next.cardId` が `a`、`waiting` に `b` があり、理由に `HTTP 422` と問い合わせ先が出る
2. 止まったカードに判断を書けない
   - コマンド: 1 の状態で `ai-board decide unstart b`
   - 期待: 「GitHub から PR の状態を引けないので」で拒まれ、0 以外で終わる。`ai-board decide unstart a` は書ける
3. 認証の失敗は全体のエラーになる
   - コマンド: 偽の `gh` を、どの問い合わせにも `(HTTP 401)` で失敗するようにして 1 と同じ
   - 期待: `forge.status` が `error`、`message` にカード ID と問い合わせ先が出て、`next` が null
4. 引ければ止まりが外れる
   - コマンド: 偽の `gh` を元に戻して 1 と同じ
   - 期待: `waiting` から `b` が消える
5. 画面の判断待ちの区画に理由が出て、ボタンが出ない（AI は画面を見られない。人が見る）
   - コマンド: 1 の状態で `ai-board` のサーバを起動してボードを開く
   - 期待: `b` が判断待ちに出て、止まりの理由が見え、判断のボタンが無い（走らせていない）

## タスク

### 1. 失敗をカードに閉じる

- [x] `forge-client.ts` に `ForgeRequestError` と `failureScope` を足す。`github-client.ts` の `get` / `getAll` が失敗を `ForgeRequestError` にして投げる（404 は今どおり null）。テストを足す
- [x] `ForgePoller` にカードごとの失敗（`failures`）を持たせ、`scope: 'card'` の失敗では接続の状態を `error` にしない。全体のエラーの文言にカード ID と問い合わせ先を出す。`MrStateProvider` に `failure` を足す。テストを足す
- [x] 品質ゲートを通す

### 2. 止まりにして、判断を止める

- [x] `CardHold` に `kind` を、`HoldInput` に `mrFailure` を足し、`resolveHold` が `forge` の止まりを返す。`HOLD_REASONS.forgeFailed` を足す。今の止まりを作る箇所とテストの値を `kind: 'decision'` に合わせる。テストを足す
- [x] `get-board.query.ts` がカードの失敗を `resolveHold` に渡し、カードごとの `mrKnown` に効かせる。`src/web/types.ts` の `CardHold` に `kind` を写す。e2e のテストを足す
- [x] `decisionsFor` が `forge` の止まりで空を返し、`ai-board decide` が承認 / 否決 / 中止・着手 / 着手を戻すを拒む。テストを足す
- [x] 品質ゲートを通す

### 3. ドキュメント

- [x] `docs/architecture.md` の「止まり」と GitHub の取得の節、`docs/adr/0006-ai-review-entries-and-hold.md`、`.claude/skills/board-loop/SKILL.md` の止まりの列挙、`README.md`（止まりの説明があれば）を今の形に書き直す
- [x] 品質ゲートを通す

## AI レビュー

- [x] `docs/specs/board-hold/spec.md:28` の新しい「Requirement: 1 枚の PR を引けないときは、そのカードだけを止める」が、既存の「Requirement: 止まりはステージとは別の軸で示す」の途中（26 行目の後）に差し込まれている。そのため、既存の要件の後半（52〜59 行目の理由と時刻・判断待ちへの表示・「人が承認 / 否決 / 中止を記録すれば止まりは外れなければならない (MUST)」・作成時から Draft の PR）と、その後の Scenario（保留・Draft に戻された など）が、新しい要件の下に入ってしまっている。新しい要件の節（28〜50 行目）を、既存の要件の最後の Scenario の後ろへ移す。あわせて 56 行目の「人が承認 / 否決 / 中止を記録すれば、そのエントリが最新になって止まりは外れなければならない」に、PR の状態を引けない止まりを除くこと（その止まりには判断を書けず、次に引ければ外れる）を書き足し、README・`docs/architecture.md` と同じ形にする

### 見送った指摘

- `docs/architecture.md` の「止まり（hold）」の節で、`forge` の止まりの箇条と残り 3 つの箇条のあいだに空行があり、Markdown では 2 つの箇条書きに分かれて見える。読み手に伝わる中身は変わらないので見送る
- `src/infrastructure/forge-poller.ts` の `describeError` は、`ForgeRequestError` の `message` から `endpoint` の長さぶんを切り落として文を組み直しており、`message` の形に依っている。今の形では正しく動き、テストもあるので見送る
