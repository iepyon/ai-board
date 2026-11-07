# GitHub が未設定のボードでも、判断を書けて次の一手が出る

## 人に判断してほしいこと

- **手順書の版を上げるか。** `board-loop` の `SKILL.md`（止まる条件）と `board-decide` の `SKILL.md`（拒まれる場合）の説明を、未設定なら止まらない・拒まない形に直す。
  ループの振る舞い（未設定のボードで次の手に進む）が変わるので、`.claude/HARNESS_VERSIONS.md` に v6 を足す。既定: 上げる
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **未設定のボードで PR 番号を持つカードを、そのカードだけの止まり（`forge`）にするか。** 既定: する。
  止まりの理由は `PR #<n> を持つが、GitHub が未設定なので PR の状態を引けない。config.yaml に github: を戻すか、中止してください` とし、判断のボタンは出さず、`decide` の判断と着手 / 着手を戻すも拒む。
  `branch` だけを持ち PR 番号を持たないカードは、PR があるか分からないが止まりにしない（`### 仮定`・`### Risks / Trade-offs`）
  - → 回答（2026-11-06、チャット）: そのカードだけ拒む
- **範囲を判断の検査と次の一手までにするか。** 既定: する。未設定のボードでループの計画の手（push と Draft の PR）を動かすこと、実装の締め（Ready）とマージ済みの判定は `branch-plan-review` などの別カードに残す。
  このカードだけでは、未設定のボードの 1 周は計画の手で止まる（`### Non-Goals`）
  - → 回答（2026-11-06、チャット）: 判断と next だけ
- **通すのを未設定（`github:` が無い）だけにするか。** 既定: する。`github:` を書いたまま届かない・`gh` が無い・未ログイン（使えません）とエラーは今どおり拒む（`### 退けた代案`）
  - → 回答（2026-11-06、チャット）: A（未設定だけ通す）
- **研修で GitHub を外す方法を、fork の `config.yaml` に `github:` を書かない運用にするか。** 既定: する。手元で上書きする口は足さない（`### Non-Goals`）
  - → 回答（2026-11-06、チャット）: fork の config から消す

## 提案

### Why

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。研修の fork では、データ用ブランチの `config.yaml` に `github:` を書かずに使う。
ところが今は、GitHub が「接続済み」でないと次のようになる。

- `ai-board decide` が、着手 / 着手を戻す / 承認 / 差し戻し / 中止を `ForgeUnavailable` で拒む（`src/board/services/decision-guards.ts` :33・:61）
- `ai-board status` が `next` を null にし、ループが止まる（`src/board/usecases/queries/get-status.query.ts` :56）

この守りは、PR の状態が引けないと 計画レビュー / PR中 のカードが手前の AI の列に落ちて見え、判断を取り違えたり人の番のカードを AI が進めたりするのを防ぐためにある。
ただ、`github:` を書いていない（未設定）ボードには、そもそも PR が無い。手前に落ちて見える心配が無いのに同じに拒むので、研修で GitHub を外すと着手も承認もできず、ループも動かない。

### What Changes

使う人から見た変化は次のとおり。

- `config.yaml` に `github:` が無い（`status` の表示が「GitHub: 未設定」）ボードで、`ai-board decide` の着手 / 着手を戻す / 承認 / 差し戻し / 中止が、接続済みのときと同じ検査で書ける
- 同じボードで、`ai-board status` の `next` が出る。ループの止まる条件から「未設定」が外れる
- 未設定のボードで PR 番号（`mr`）を持つカード（途中で `github:` を外したボードの、PR の付いたカード）は、そのカードだけ止まり（`forge`）になる。
  判断待ちに理由が出て、判断も次の一手も、そのカードには出ない。ほかのカードは進む
- 次は今のまま拒み、`next` も出さない
  - `github:` を書いたまま、GitHub に届かない・`gh` が無い・未ログイン（「GitHub: 使えません（…）」）
  - 起動の確認は通ったが、その後の取得が失敗した（「GitHub: エラー（…）」）

### Impact

- 接続の見分け: `src/board/models/mr-state.ts`（未設定かを見る純関数）
- 判断の検査: `src/board/services/decision-guards.ts`
- 次の一手と文言: `src/board/usecases/queries/get-status.query.ts`、`src/board/cli/status-describe.ts`、`src/board/cli/decide-cli.ts`（拒む理由の docstring と文言）
- 止まり: `src/board/services/next-action.ts`（`HoldInput`・`resolveHold`・`HOLD_REASONS`）、`src/board/usecases/queries/get-board.query.ts`
- ドキュメント: `README.md`、`docs/architecture.md`、`docs/specs/board-hold/spec.md`、`docs/adr/0003-delegate-github-to-gh.md`、`docs/adr/0006-ai-review-entries-and-hold.md`
- 手順書: `.claude/skills/board-loop/SKILL.md`、`.claude/skills/board-decide/SKILL.md`、`.claude/HARNESS_VERSIONS.md`
- ステージの導出（`stage-resolver.ts`）・データ用ブランチの形の版・GitHub への問い合わせ: 変わらない

## 設計

### Decisions

#### 未設定を見分ける

- `src/board/models/mr-state.ts` に純関数 `isForgeUnset(forge: ForgeConnection): boolean` を足す。`forge.status === 'disabled' && forge.kind === null` のときだけ真
  - `kind` が null の `disabled` は、`createMrStateSource` が `forge === null`（`config.yaml` に `github:` が無い）のときにだけ作る（`disabledMrStateProvider`）
  - `github:` を書いたまま `checkAuth` が失敗したとき（`gh` が無い・未ログイン・オフライン）は `unavailableMrStateProvider` が `kind: 'github'` と `reason` を付けるので、偽になる
- 同じ所に `forgeTrusted(forge: ForgeConnection): boolean` を足す。`forge.status === 'connected' || isForgeUnset(forge)`。
  意味は「このボードの列を PR の状態で取り違えていない」。docstring に、接続済みは PR の状態を引けているから、未設定は PR がそもそも無いから、と書く

#### 判断の検査と次の一手で、未設定を通す

- `guardReview` と `guardStartedAt` の `board.forge.status !== 'connected'` を `!forgeTrusted(board.forge)` に替える。docstring の「GitHub に繋がらなければ拒む」を「接続済みか未設定でなければ拒む」に直す
- `buildStatusReport` の `next` を `forgeTrusted(board.forge) ? pickNextAction(cards) : null` にする。docstring の「`github:` の無いリポジトリでも同じで…」を、未設定なら PR が無いので出す、に書き直す
- `describeNext` の理由の分け方を `forgeTrusted(forge)` にする（未設定で `next` が null なら「AI が進められるカードはありません」）
- `decide-cli.ts` の `describeRefusal` の docstring を直す。文言（`GitHub に繋がらないので…`）は、拒むのが「使えません」と「エラー」だけになるので変えない

#### 未設定のボードで PR 番号を持つカードを止める

- `HoldInput` に `unsetPr: { readonly iid: number; readonly since: string } | null` を足す。未設定のボードでカードが PR 番号を持つときだけ値が入る
- `resolveHold` は、`mrFailure` の判定のすぐ後、列ごとの判定の前に、中止でなく、列が アイデア / マージ済み 以外で `unsetPr` があれば
  `{ kind: 'forge', reason: HOLD_REASONS.forgeUnset(iid), since }` を返す。
  `HOLD_REASONS.forgeUnset(iid)` は `PR #<iid> を持つが、GitHub が未設定なので PR の状態を引けない。config.yaml に github: を戻すか、中止してください`
- `get-board.query.ts` は、`isForgeUnset(forge)` かつ `card.mr !== null` のカードに `unsetPr: { iid: card.mr, since: <ボードを組む時刻> }` を渡す。
  `droppableStages` は、`mrFailure` があるときと同じく、`unsetPr` があれば空にする（`ai-board decide` の着手 / 着手を戻すが `StageMismatch` で拒む）
- `decisionsFor` は `hold.kind` が `forge` なら空を返す（今のまま）ので、承認 / 差し戻し / 中止は `DecisionUnavailable` で拒まれ、`waiting[].decisions` も空になる。新しい分岐は足さない
- `pickNextAction` は止まりを飛ばす（今のまま）ので、そのカードは選ばれない
- ボードを組む時刻は、`getBoardQuery` が返す `generatedAt` と同じ値を 1 回だけ作って使う

#### ドキュメントと手順書

- `docs/adr/0003-delegate-github-to-gh.md` の決定に「`github:` が無い（未設定）ボードは PR を持たないので、判断と次の一手を接続済みと同じに通す。
  `github:` があって使えない・エラーのときは、列を取り違えるので拒む」を足し、退けた案に「`disabled` なら通す」（`github:` を書いたままオフラインになったボードも通り、PR を持つカードが手前に落ちて見える）を足す。日付に改訂を足す
- `docs/adr/0006-ai-review-entries-and-hold.md` の止まりの種類（`forge`）に、未設定のボードで PR 番号を持つカードを足す
- `docs/specs/board-hold/spec.md` に、未設定のボードで PR 番号を持つカードが止まり、ほかのカードが次の一手に選ばれるシナリオを足す
- `docs/architecture.md` の「GitHub の PR の取得」の冒頭と、`README.md` :151 の「GitHub に繋がらないときは判断と着手を拒む」を、未設定なら通す形に直す
- `.claude/skills/board-loop/SKILL.md` の手順 2 の「`forge.status` が `connected` でないとき（…`config.yaml` に `github:` が無い）」から未設定を外し、
  未設定のボードでは `next` が出ること、ただし計画の手は Draft の PR を出せずに止まることを書く
- `.claude/skills/board-decide/SKILL.md` の手順 4 の「GitHub に繋がらないときの…を拒む」に、未設定なら拒まないことを添える
- `.claude/HARNESS_VERSIONS.md` に v6 を足す（人の判断で上げないなら外す）

### 仮定

- **未設定は `kind` が null の `disabled` で見分ける。** `ForgeConnection` の型の docstring（`mr-state.ts` :92）が「`disabled` は設定が無い場合と、CLI が無い・未ログインの場合の両方を表し、どちらであるかは `reason` に出す」としている。
  `reason` ではなく `kind` で見るのは、未設定のとき `kind` が必ず null で、`github:` を書いたときは必ず `'github'` になり、文言に依らないため（`composition.ts` の `createMrStateSource`）
- **PR 番号を持つカードを止めるかは、カードの `mr` だけで見る。** `mr` は接続済みのときに `branch` から解決して書き戻した番号で、`github:` を外した後も残る。
  計画が archive されたカードはマージ済みの列になり、止まりの対象から外れる（`resolveHold` はアイデア / マージ済みを見ない）
- **`branch` だけを持ち `mr` の無いカードは止めない。** PR があるか分からないが、未設定のボードで計画の手を進めたカードは `branch` だけを持つのが普通になる（`branch-plan-review` が入れば、この形で計画レビューを立てる）。
  これを止めると、未設定のボードで計画を出したカードがすべて止まる
- **止まりの `since` はボードを組む時刻にする。** `forge` の止まりの `since` は区間の時間（`timeline`）に使わない（`forge-card-error` の計画の仮定と同じ）
- **止まりの種類は `forge` を使い、新しい種類を足さない。** 「PR の状態が引けないので列を信じられない」という中身が同じで、`decisionsFor` と `droppableStages` の扱いも同じになるため
- **`describeRefusal` の文言は変えない。** 拒むのは「使えません」「エラー」のときだけになり、「GitHub に繋がらないので」はそのまま当たる
- **研修で GitHub を外す方法は、fork のデータ用ブランチの `config.yaml` に `github:` を書かない運用とする。** 手元で上書きする口は足さない（人の答え、2026-11-06）

### 退けた代案

- **`disabled` なら `kind` に依らず通す:** `github:` を書いたままオフライン・`gh` が無い・未ログインのボードも通り、PR を持つカードが手前の列に落ちて見えたまま判断と次の一手が出る（人の答え、2026-11-06）（人に判断してほしいこと）
- **PR 番号を持つカードが 1 枚でもあれば、未設定のボード全体を拒む:** 本番のボードで `github:` を外すと何もできなくなる。そのカードだけ止めれば、ほかのカードは進められる（人の答え、2026-11-06）（人に判断してほしいこと）
- **PR 番号を持つカードを守らない:** 研修は最初から `github:` を書かない前提でも、途中で外したボードで人の番のカードを AI が進めかねない（人の答え、2026-11-06）
- **`mrFailure`（`ForgeCardFailure`）に未設定のときの値を入れて流用する:** 止まりの理由が「時間を置いても続くなら、GitHub で PR を確かめてください」になり、未設定のボードでは当たらない。理由の文を分けるため、入力を分ける
- **`stage-resolver.ts` に未設定の条件を足す:** 導出の核に GitHub の接続の条件を持ち込むことになる。変えるのは検査と次の一手の入口だけにする（カードのアイデア）
- **ループの計画の手（push と Draft の PR）も未設定に合わせる:** 計画レビューを立てるのに `branch-plan-review` の変更が要り、範囲が倍になる（人に判断してほしいこと）

### Risks / Trade-offs

- このカードだけでは、未設定のボードの 1 周は回らない。ループは着手したカードの計画の手で、push か `ai-board pr create` に失敗して `止まった` で終わる。
  計画の手を未設定に合わせるのは `branch-plan-review` などの別カードに残す
- 途中で `github:` を外したボードで、`branch` だけを持ち `mr` がまだ書き戻されていないカード（PR を出した直後に外した、など）は、PR があっても止まりにならない。
  `status` は接続済みのときに `branch` から番号を書き戻すので、PR を出した後に 1 回でも `status` か `decide` を走らせていれば `mr` が入る
- 未設定のボードでは `planLost`（提出済みなのに計画も PR も見えない）の止まりが立たない（`mrKnown` が偽のまま）。今と同じで、このカードでは変えない

### Non-Goals

- 未設定のボードで、ループの計画の手（push と Draft の PR）を進めること。ブランチの計画で計画レビューを立てること（`branch-plan-review`）（人に判断してほしいこと）
- 実装の締め（Ready）と、PR の無いボードでのマージ済みの判定（人に判断してほしいこと）
- `github:` を書いたまま届かないボード（「使えません」「エラー」）の扱いの変更（`offline-snapshot-view`）（人に判断してほしいこと）
- 手元のファイルで GitHub を外す口を足すこと（人に判断してほしいこと）
- ステージの導出の変更

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                   | 反映した先                                                    | 反映しなかった理由                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | `offline-data-mode` の調べで見つけ、人の答えで別のカードにした                                         | Why                                                           |                                                                                                                 |
| 2   | `offline-snapshot-view` は「ループと判断の検査は今のまま」。届かない（`error`）ときはそれと揃える      | What Changes（今のまま拒むもの）・Non-Goals                   |                                                                                                                 |
| 3   | 計画で決めること: 計画の手（Draft の PR）をループがどう進めるか。`branch-plan-review` とのかみ合わせ   | Non-Goals・Risks / Trade-offs・人に判断してほしいこと         |                                                                                                                 |
| 4   | 計画で決めること: 途中で `github:` を足したり外したりしたとき、PR を持つカードが手前に落ちて見えないか | Decisions（未設定のボードで PR 番号を持つカードを止める）     |                                                                                                                 |
| 5   | 計画で決めること: ADR 0007・ADR 0003 への書き足し                                                      | Decisions（ドキュメントと手順書）                             | ADR 0007 は人の判断を書く主体と守りの話で、GitHub の接続に触れていないので書き足さない。ADR 0003 と 0006 に書く |
| 6   | 届かない環境は `error` ではなく `disabled` になる（`checkAuth`・`unavailableMrStateProvider`）         | Decisions（未設定を見分ける）・仮定                           |                                                                                                                 |
| 7   | 状態は 4 つ。「`disabled` なら通す」と書くと②も通ってしまう                                            | Decisions（未設定を見分ける）・退けた代案                     |                                                                                                                 |
| 8   | 未設定のボードでは、判断と `next` を通しても、ループは計画の手で止まる                                 | Risks / Trade-offs・Non-Goals・手順書の `SKILL.md` の書き直し |                                                                                                                 |
| 9   | 途中で `github:` を外すと PR を持つカードが手前に落ちる。`mrFailure` と同じ扱いが使える見込み          | Decisions（未設定のボードで PR 番号を持つカードを止める）     |                                                                                                                 |
| 10  | 「`github:` の無いリポジトリでも `next` を出さない」は docstring にある判断で、ADR には無い            | Decisions（ドキュメントと手順書。ADR 0003）                   |                                                                                                                 |
| 11  | 人の答え: 通すのは①未設定だけ。②使えません と④エラーは今どおり拒む                                     | Decisions（未設定を見分ける）・退けた代案                     |                                                                                                                 |
| 12  | 人の答え: 範囲は判断の検査と `next` まで。計画の手は `branch-plan-review` などに任せる                 | Non-Goals・人に判断してほしいこと                             |                                                                                                                 |
| 13  | 人の答え: `mr` を持ち archive されていないカードは、そのカードだけ拒む                                 | Decisions（未設定のボードで PR 番号を持つカードを止める）     |                                                                                                                 |
| 14  | 人の答え: fork の `config.yaml` に `github:` を書かない運用。手元で上書きする口は足さない              | 仮定・Non-Goals                                               |                                                                                                                 |

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/forge-unset-decide`（以下 `$WT`）。`rules.md` の「動かして確かめるとき」のとおり、スクラッチパッドの bare リポジトリを `origin` にした clone（`$S/data`）を `AI_BOARD_DATA` で指す。
`$S/data` の `config.yaml` には `github:` を書かない（未設定）。本物の GitHub は使わない。
計画ファイルを置くために、空の git リポジトリ `$S/repo` を作って `--root $S/repo` で走らせる。以下 `B` は `AI_BOARD_DATA=$S/data node $WT/dist/cli.js` と `--root $S/repo` を付けて走らせることを指す。

1. 未設定のボードで着手が書ける
   - コマンド: `B card create --id alpha --title A < 本文` でアイデアを作り、`B decide start alpha`
   - 期待: `alpha: 着手 を書きました（アイデア → 計画提案中）` で 0 で終わる
2. 未設定のボードで次の一手が出る
   - コマンド: 1 の後に `B status --json --only next,forge`、続けて `B status`
   - 期待: `forge` が `{"status":"disabled","kind":null,"reason":null}`、`next` が `{"cardId":"alpha","action":"plan",…}`。人向けの出力は「GitHub: 未設定」「次の一手: plan alpha（…）」
3. 未設定のボードで計画の承認が書ける
   - コマンド: `$S/repo/.ai-board/plans/alpha.md` に計画を置き、`B card submit alpha --reason なし` の後に `B decide approve alpha`
   - 期待: `alpha: plan 承認 を書きました（計画レビュー → 実装中）`
4. PR 番号を持つカードはそのカードだけ止まる
   - コマンド: カード `beta` を作って着手する。`card` の CLI では `mr` を書けないので、試しの clone の `$S/data/cards/beta.md` の front matter に `mr: 7` を足してコミットする（共有のデータ用ブランチではない）。
     `B status --json --only next,waiting` と `B decide unstart beta`
   - 期待: `waiting` に `beta` が出て、理由が `PR #7 を持つが、GitHub が未設定なので…`、`decisions` が空。`next` は `beta` を選ばない。`decide unstart beta` は 0 以外で拒まれる
5. `github:` を書いたまま使えないボードは今どおり拒む
   - コマンド: `$S/data` の `config.yaml` に `github:` と `repository: 'example/none'` を足してコミットし、`gh` の無い `PATH` で `B status` と `B decide start <アイデアの ID>`
   - 期待: 「GitHub: 使えません（…）」「次の一手: なし（GitHub に接続できないため、ループは止まります）」、`decide` は「GitHub に繋がらないので、着手 / 着手を戻すは書けません」で拒まれる
6. 未設定のボードでループを 1 周回すと、計画の手で止まる（共有のカードを使うので AI は走らせていない。人が研修の fork で確かめる）
   - コマンド: 研修の fork で `github:` を消し、カードに着手して `/board-loop`
   - 期待: ループが `plan` の手に入り、push か `ai-board pr create` の失敗で `止まった` で終わる（このカードの範囲外であることの確かめ）

## タスク

### 1. 未設定を見分け、判断の検査と次の一手で通す

- [x] `src/board/models/mr-state.ts` に `isForgeUnset` と `forgeTrusted` を足し、`ForgeConnection` の docstring に未設定の見分け方を書く
- [x] `src/board/services/decision-guards.ts` の `guardReview` / `guardStartedAt` を `forgeTrusted` で判定し、docstring を直す
- [x] `src/board/usecases/queries/get-status.query.ts` の `next` を `forgeTrusted` で判定し、docstring を直す
- [x] `src/board/cli/status-describe.ts` の `describeNext` を `forgeTrusted` で分け、`src/board/cli/decide-cli.ts` の `describeRefusal` の docstring を直す
- [x] テスト: `mr-state` の見分け（未設定・使えません・エラー・接続済み）、`decision-guards`（未設定なら通す、使えませんなら拒む）、`get-status.query`（未設定なら `next` が出る、使えませんなら null）、`status-describe`、`decide-cli`（未設定のボードで着手が書ける）

### 2. 未設定のボードで PR 番号を持つカードを止める

- [x] `src/board/services/next-action.ts` に `HoldInput.unsetPr` と `HOLD_REASONS.forgeUnset` を足し、`resolveHold` で `forge` の止まりを返す。docstring に足す
- [x] `src/board/usecases/queries/get-board.query.ts` で、未設定のボードの `mr` を持つカードに `unsetPr` を渡し、`droppableStages` を空にする
- [x] テスト: `resolveHold`（`unsetPr` で止まる、アイデア / マージ済み / 中止では止まらない）、`get-board.query`（未設定で `mr` を持つカードだけ止まり、`droppableStages` が空）、`get-status.query`（止まったカードを飛ばして次のカードを選ぶ）、`decide-cli`（止まったカードの着手を戻すと承認を拒む）

### 3. ドキュメントと手順書

- [x] `docs/adr/0003-delegate-github-to-gh.md` と `docs/adr/0006-ai-review-entries-and-hold.md` を書き足す（`adr` のスキル）
- [x] `docs/specs/board-hold/spec.md` にシナリオを足し、`docs/architecture.md` と `README.md` を直す
- [x] `.claude/skills/board-loop/SKILL.md` と `.claude/skills/board-decide/SKILL.md` を直す
- [x] `.claude/HARNESS_VERSIONS.md` に v6 を足す（人の判断で上げないなら、このタスクを外す）

## AI レビュー

- [x] `docs/architecture.md:85` の「次の一手は … `pickNextAction`。GitHub に接続できない（`forge.status` が `connected` でない）と `next` は `null`」が古い。この PR で `buildStatusReport`（`src/board/usecases/queries/get-status.query.ts`）は `forgeTrusted` で判定し、未設定（`kind` が null の `disabled`）なら `next` を出すようになった。「接続済みか未設定（`forgeTrusted`）でないと `next` は `null`。未設定のボードで PR 番号を持つカードは止まりになり選ばれない」の形に直す（同じファイルの「GitHub の PR の取得」の冒頭と揃える）
