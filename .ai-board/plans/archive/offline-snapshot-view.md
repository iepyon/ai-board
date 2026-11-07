# GitHub に届かないときも、マージ済みの PR の控えでボードを描く

## 人に判断してほしいこと

- **`status` の「GitHub: 使えません（…）」の行に、マージ済みの PR を控えで出していることを添えるか。** 添えるなら、例えば「GitHub: 使えません（…）。マージ済みの PR は手元の控えで表示」とする。人の答え（2026-11-07）でマージ済みだけを読むと決め、取得時刻は持たせないので、添えなくても古さで取り違えることは無い。既定: 添えない（`### Non-Goals`）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **`github:` があって `gh` は動くが、問い合わせが途中で失敗した（「GitHub: エラー（…）」）ボードの扱いを、このカードで揃えるか。** この場合は今も、ポーラーが最初に控えを読み戻すので、マージ済みに加えてマージ前の控え（`cache/`）でもボードを描いている。人の答え（マージ済みだけを読む）と食い違うが、今の振る舞いで、このカードが足すものではない。既定: 触らない（`### Non-Goals`）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）

## 提案

### Why

`config.yaml` に `github:` を書いたボードで GitHub に届かない（`gh` が無い・未ログイン・ネットワークが無い）と、`createMrStateSource` の `checkAuth` が失敗し、`unavailableMrStateProvider` がすべての PR を null で返す（`src/board/composition.ts`）。
データ用ブランチにあるマージ済みの PR の控え（`snapshots/<id>.json`）は手元にあるのに読まない。
そのため、マージ済みのカードの PR のリンク・Ready とマージの時刻が消え、区間の時間も PR の分（PR レビュー・マージ）が欠ける。
列は計画の archive で「マージ済み」と導かれるので崩れないが、普段 GitHub につないでいるボードが一時的に届かないだけで、終わったカードの記録が欠けて見える。

マージ済みの PR は二度と変わらないので、控えを読めば古さを気にせずに最後の状態で描ける。

### What Changes

使う人から見た変化は次のとおり（どれも `github:` を書いてあって「GitHub: 使えません（…）」になるボードだけ）。

- `status --json` の `cards[].mrState` に、マージ済みの PR の控えが載る（番号・URL・`mergedAt`・`readyAt` など）
- マージ済みのカードの区間の時間（`timeline`）に、PR レビューとマージの区間が戻る
- マージ前の PR のカードは今までどおり（PR の状態は null で、手前の列に見える）
- 次の一手は今までどおり出さず、`ai-board decide` の判断と着手も今までどおり拒む（`forgeTrusted` は変えない）
- 「GitHub: 使えません（…）」の行の文言は変えない（人に判断してほしいこと）
- 接続済み・未設定・エラーのボードは何も変わらない

### Impact

- 控えのリポジトリ: `src/board/repositories/mr-snapshot.repository.ts`・`file-mr-snapshot.repository.ts`（マージ済みだけを読む `findMerged` を足す）
- 届かないときの供給元: `src/board/services/mr-state-provider.ts`（`unavailableMrStateProvider` がマージ済みの控えを受け取る）
- 組み立て: `src/board/composition.ts`（`createMrStateSource` が届かないときに控えを読んで渡す）
- ドキュメント: `docs/architecture.md`（GitHub の PR の取得・控え）、`README.md`（GitHub との接続）
- ステージの導出（`stage-resolver.ts`）・止まり（`resolveHold`）・次の一手・判断の検査・控えの形・データ用ブランチの形の版・手順書: 変わらない

## 設計

### Decisions

#### マージ済みの控えだけを読む口

- `MrSnapshotRepository` に `findMerged(): Promise<Map<CardId, MrSnapshot>>` を足す
- `FileMrSnapshotRepository.findMerged` は、データ用ブランチの `snapshots/` だけを読む（今の `readMerged` を返す）。`cache/mr-snapshots.json` は読まない
- `findAll` は今のまま（ポーラーが使う）

#### 届かないときの供給元

- `unavailableMrStateProvider(kind, reason, merged = new Map())` に、カード ID からマージ済みの PR の状態への表を渡せるようにする
  - `get(cardId)` は表にあればその `MrState`、無ければ null を返す
  - `connection()` は今のまま `{ status: 'disabled', kind, reason }`。`synced()` は false、`failure()` は null のまま
  - `synced()` を false に保つので、「PR が見えない」ことを根拠にする止まり（`planLost`）は今どおり立たない。`forgeTrusted` も偽のままなので、次の一手と判断の検査は変わらない

#### 組み立て

- `createMrStateSource` で `checkAuth` が失敗したら、`snapshotRepository.findMerged()` と `cardRepository.findAll()` を読み、控えのうち **カードの `mr` と番号が合うものだけ** を表にして `unavailableMrStateProvider` に渡す
  - 番号を付け替えたカード、カードが無くなった控えは載せない（接続済みならポーラーが引き直す・消すものを、届かないときは使わないだけにする）
  - 読むのに失敗したら（例外）、警告して空の表で続ける。今の「すべて null」に戻るだけで、ボードは落とさない
- 控えには書かない（届かないので、ポーラーを作らない今の形のまま）

### 仮定

- **対象は `checkAuth` が失敗したとき（「使えません」）だけにする。** 人の答え（2026-11-07）の「`github:` を設定してあるのに届かない」は、`gh` が無い・未ログイン・ネットワークが無いのどれでも `checkAuth`（`gh api repos/<owner>/<repo>`）で落ちる。`checkAuth` が通った後の失敗（「エラー」）は、ポーラーが既に控えを読み戻している（`ForgePoller.load`）ので、今も PR の状態は欠けない
- **マージ済みかは置き場所で決める。** `snapshots/` には `state: merged` の控えだけが書かれる（`FileMrSnapshotRepository.save`）。`findAll` を `state` で絞る形より、人の答え（「`snapshots/` だけを読む」）にそのまま合う
- **カードの `mr` と番号が合う控えだけを使う。** 接続済みでは、番号の違う控えをポーラーが引き直して上書きする。届かないと引き直せないので、合わない控えは古い PR のものとみなして使わない
- **控えの形は変えない。** 取得時刻を持たせない（人の答え）。`MrState` に項目を足すと、データ用ブランチの 50 余りの控えが検証で外れ、次に届いたときに引き直して書き直すことになる
- **ADR は書かない。** 今の不変条件（ステージを保存しない・控えは導出の入力ではなく問い合わせを省くもの・届かないときは判断と次の一手を止める）を崩さない。控えの扱いは `docs/architecture.md` に書いてあるので、そこを直す

### 退けた代案

- **マージ前の控え（`cache/`）も読み、取得時刻を出す:** 人の答え（2026-11-07）。古い状態で 計画レビュー / PR中 に見え、取得時刻で古さを見せる仕組みが要る
- **届かないときもポーラーを作り、問い合わせだけ止める:** ポーラーは控えを書き、対象外の控えを消す（`forgetUntracked`）。届かないときに控えを書き換える道を増やさない
- **`findAll` を `state === 'merged'` で絞る:** `cache/` にマージ済みが紛れていれば読んでしまう。置き場所で分けるほうが人の答えに合う（仮定）
- **「使えません」の行に控えで出していることを添える:** 人に判断してほしいこと。既定は添えない（人に判断してほしいこと）

### Risks / Trade-offs

- 計画を archive する前に人が PR をマージしたカードは、届かないあいだもマージ済みの控えで「マージ済み」と導かれる。接続済みと同じ導き方で、取り違えではない
- 届かないあいだに人が GitHub で PR を作り直して番号を付け替えても、カードの `mr` が古いままなら古い控えを使う。届けばポーラーが引き直す
- `checkAuth` が失敗したプロセスごとに、`snapshots/` のファイルとカードを 1 回ずつ読む。読むのは手元のファイルだけで、ネットワークは使わない

### Non-Goals

- 取得時刻を控えに持たせること・`status` に出すこと（人の答え）
- マージ前の控え（`cache/`）を届かないときに使うこと（人の答え）
- 「GitHub: 使えません（…）」の行に、控えで出していることを添えること（人に判断してほしいこと）
- 「GitHub: エラー（…）」のボードでマージ前の控えも使っている今の振る舞いを、マージ済みだけに揃えること（人に判断してほしいこと）
- 届かないときの次の一手・判断の検査を緩めること（カードの「ループと判断の検査は今のまま」）
- ダッシュボード（ADR 0017 で外した）や Artifact のボード（`board-artifact-view`）への表示

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                          | 反映した先                                                 | 反映しなかった理由                                                             |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | マージ済みの控えは `snapshots/<id>.json`、マージ前は git に載らない `cache/mr-snapshots.json` | Decisions（マージ済みの控えだけを読む口）・仮定            |                                                                                |
| 2   | 控えは PR の事実で、ステージではない。ステージを保存しない決まりは崩れない                    | 仮定（ADR は書かない）                                     |                                                                                |
| 3   | 計画で決めること: マージ前の控え（`cache/`）も表示に使うか。入口の分け方                      | Non-Goals・退けた代案                                      |                                                                                |
| 4   | 計画で決めること: 取得時刻を控えのどこに持つか                                                | 仮定（控えの形は変えない）・Non-Goals                      |                                                                                |
| 5   | `board-artifact-view` などダッシュボードのカードは、この上に載せる                            | Non-Goals                                                  |                                                                                |
| 6   | 2026-11-07 の調べ: 効くのは `github:` を設定してあるのに届かないときだけ                      | 提案（Why）・仮定（対象は「使えません」だけ）              |                                                                                |
| 7   | 2026-11-07 の調べ: 計画が archive にあればマージ済みに導かれる。欠けるのはリンク・時刻・区間  | 提案（Why・What Changes）                                  |                                                                                |
| 8   | 2026-11-07 の調べ: ダッシュボードは外したので、表示先は `status`                              | What Changes・Non-Goals                                    |                                                                                |
| 9   | 2026-11-07 の調べ: 控えには取得時刻の項目がまだ無い                                           | 仮定（控えの形は変えない）                                 |                                                                                |
| 10  | 人の答え: カードは続ける。対象は `github:` を設定してあるのに届かないとき                     | 提案（Why）・仮定                                          |                                                                                |
| 11  | 人の答え: 届かないときはマージ済みの控えだけを読み、取得時刻は持たせない                      | Decisions・仮定・Non-Goals・退けた代案                     |                                                                                |
| 12  | 人の答え: 取得時刻を出すならボード全体で 1 行（今回は使わない）                               |                                                            | マージ済みだけを読むので取得時刻を持たせない（人の答えのとおり今回は使わない） |
| 13  | アイデア: ループと判断の検査は今のまま                                                        | Decisions（届かないときの供給元）・What Changes・Non-Goals |                                                                                |

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/offline-snapshot-view`（以下 `$WT`）。`rules.md` の「動かして確かめるとき」のとおり、スクラッチパッドの bare リポジトリを `origin` にした clone（`$S/data`）を `AI_BOARD_DATA` で指す。
`$S/data` の根に `config.yaml`（`github: { repository: 'example/none' }`）を置き、`gh` の無い `PATH`（`node` だけを置いたディレクトリ）で走らせて「使えません」にする。
控えは `$S/data/snapshots/<id>.json` に手で置いてデータ用ブランチにコミットする（スクラッチの clone なので本物に触らない）。以下 `B` は `AI_BOARD_DATA=$S/data PATH=<node だけ> node $WT/dist/cli.js` を指す。

1. 届かないとき、マージ済みの控えが `mrState` に載る
   - コマンド: `B card create --id alpha …` → `B card branch alpha alpha`。カードの `mr` を 7 にした状態（`snapshots/alpha.json` に `iid: 7` の `state: merged` の控えを置き、接続済みのときに書き戻されるのと同じく、カードの `mr` を 7 にしてコミット）で `B status --json --only forge,cards.id,cards.stage,cards.mrState`
   - 期待: `forge` が `{ status: 'disabled', kind: 'github', … }`。`alpha` の `mrState` が `iid: 7`・`state: merged` で、`stage` が `merged`
2. 番号の合わない控えは使わない
   - コマンド: 1 の控えを `iid: 8` に書き換えてコミットし、同じく `B status --json --only cards.id,cards.mrState`
   - 期待: `alpha` の `mrState` が null
3. マージ前の控え（`cache/`）は使わない
   - コマンド: `$S/cache/mr-snapshots.json` に、`mr` が 9 のカード `beta` の `state: opened` の控えを置いて `B status --json --only cards.id,cards.mrState`
   - 期待: `beta` の `mrState` が null
4. 次の一手と判断の検査は変わらない
   - コマンド: `B status --json --only next` と `B decide start <アイデアのカード>`
   - 期待: `next` が null。`decide` は今どおり GitHub に届かないことを理由に拒む
5. 人向けの出力は今のまま
   - コマンド: `B status`
   - 期待: 「GitHub: 使えません（…）」の行が今と同じ文言で出る
6. 普段の接続済みのボードで変わらない（共有のカードを読むので AI は走らせていない。人が手元で確かめる）
   - コマンド: メインのチェックアウトで `ai-board status --json --only forge,cards.id,cards.mrState`
   - 期待: 今と同じく接続済みで、マージ済みのカードに `mrState` が載る

## タスク

### 1. 届かないときにマージ済みの控えを読む

- [x] `src/board/repositories/mr-snapshot.repository.ts` に `findMerged` を足し、`file-mr-snapshot.repository.ts` で `snapshots/` だけを読む形で実装する（テストの差し替え実装にも足す）
- [x] `src/board/services/mr-state-provider.ts` の `unavailableMrStateProvider` が、マージ済みの PR の状態の表を受け取り `get` で返すようにする
- [x] `src/board/composition.ts` の `createMrStateSource` で、`checkAuth` が失敗したら `findMerged` とカードを読み、`mr` と番号の合う控えだけを渡す（読めなければ警告して空の表）
- [x] テスト: `findMerged`（`snapshots/` だけを読み `cache/` を読まない）、`unavailableMrStateProvider`（表にあれば返す・`synced` は false）、`createMrStateSource`（届かないときマージ済みで番号の合う控えだけを返す・番号が違えば null・読めなければ空）、`get-status.query`（届かないとき控えがあっても `next` は null）

### 2. ドキュメント

- [x] `docs/architecture.md` の「GitHub の PR の取得」と「控え」に、届かないときはマージ済みの控えだけを読むことを書く
- [x] `README.md` の「GitHub との接続」に、使えないあいだもマージ済みの PR は手元の控えで出ることを書く

## AI レビュー

直す指摘は無い。

### 見送った指摘

- `src/board/services/mr-state-provider.ts:74` の `matchMergedSnapshots` は番号だけを照らし、`snapshot.mr.state === 'merged'` を確かめない。`snapshots/` に `merged` 以外の控えが手で置かれれば、届かないあいだにそれを出す。`snapshots/` に書くのは `FileMrSnapshotRepository.save` の `state === 'merged'` の枝だけで、計画の仮定「マージ済みかは置き場所で決める」のとおりなので見送る
- `src/board/composition.ts:142` の `readMergedSnapshots` は、カードの読み込みと控えの読み込みを 1 つの try/catch で包むので、カードを読めない失敗も「マージ済みの PR の控えを読めませんでした」と警告する。その後のボードの読み込みが本当の原因で失敗するので振る舞いは変わらず、警告の文言だけの話なので見送る
- `src/board/composition.ts:122` で、届かないときにカードを `get-board` とは別にもう 1 度読み、`checkAuth` が失敗してから読み始める。手元のファイルを読むだけで、計画の Risks / Trade-offs で受け入れた費用なので見送る
- `src/board/services/mr-state-provider.ts:66` の番号の照らし合わせが、`src/infrastructure/forge-poller.ts:268` の `isSettled` と同じ判定の重複になっている。振る舞いを変えない整理なので見送る
- `src/board/services/mr-state-provider.ts:74` で、控えの `forge`・`sourceBranch` を今の設定やカードの `branch` と照らさない。接続済みのポーラーにも同じ照らし合わせは無く、この PR の目的の外なので見送る
- マージ済みの `MrState` の組み立てが、`mr-state-provider.test.ts`・`composition.test.ts`・`get-status.query.test.ts` の 3 か所に重複している。テストの整理なので見送る
