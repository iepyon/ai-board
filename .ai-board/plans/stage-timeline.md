# カードが各工程にいた時間を、残った痕跡から区間の並びとして導出する

## この計画で使う言葉

- **痕跡**: カードと PR に残っている時刻のこと。カードの `created`（起票）と `startedAt`（着手）、本文の `## レビュー` の各エントリの時刻、PR の Ready にした時刻・マージした時刻・Draft に戻した時刻がある
- **区間**: カードがある工程にいた時間を、始まりと終わりの時刻で表したもの。担当（人 / AI）を持つ。例: 「計画レビュー（人）: plan 提出 → plan 承認」
- **区間の並び（タイムライン）**: 1 枚のカードの区間を時刻の順に並べたもの。差し戻しがあれば同じ種類の区間が何度も現れる

## 提案

### Why

AI 駆動開発のどこがボトルネックか（人の判断待ちか、AI の作業か、差し戻しか）を、ボードから意識できるようにしたい。
研修では受講者がこのリポジトリを fork してループを回すので、回した結果を時間で振り返れることが学びの中心になる。

ボードは今、カードが「今どの列にいるか」しか出さない。各列にどれだけいたかは、本文の `## レビュー` の時刻を人が目で拾って引き算するしかない。
しかも PR を Ready にした時刻はどこにも引いていないので、「Ready にする」と「PR レビュー」の区間は境目が分からない。

計測が後回しになると、それまでに回した周のデータが残らない。
幸い、区間の境目になる時刻はほとんどがすでにカードと PR に残っている。グラフ（`bottleneck-chart`）より先に、区間を出せるようにしておく。

### What Changes

- `GET /api/board` と `ai-board status --json` の各カードに `timeline`（区間の並び）が増える。区間は `kind`（区間の種類）/ `owner`（`human` / `ai`）/ `start` / `end`（今いる区間は `null`）を持つ
- PR を Ready にした時刻（GitHub の `ready_for_review` のイベント）を引き、`MrState.readyAt` に持つ。`GET /api/board` の `mrState.readyAt` にも出す
- 区間は保存しない。ステージと同じく、毎回痕跡から導出する。導出は純関数にしてテストを書く
- 画面には何も足さない（グラフは `bottleneck-chart` で作る）

### Impact

- 導出: `src/board/services/stage-timeline.ts`（新規）、`src/shared/timeline.ts`（新規。区間の種類と担当の定義）
- PR の状態: `src/board/models/mr-state.ts`、`src/board/services/github-client.ts`、`src/board/repositories/sqlite-mr-snapshot.repository.ts`、`src/infrastructure/forge-poller.ts`
- 組み立て: `src/board/models/board-card.ts`、`src/board/usecases/queries/get-board.query.ts`、`src/web/types.ts`（型だけ）
- テスト: 新しい純関数のテストに加え、`MrState` を組み立てているテスト（github-client / forge-poller / next-action / stage-resolver / e2e / snapshot のリポジトリ）の fixture に `readyAt` が要る
- ドキュメント: `CLAUDE.md`、`README.md`、`docs/specs/board-stages/spec.md`
- DB: マイグレーションは要らない。`mr_snapshots` の控えは JSON で、形の合わない古い控えは読むときに外して引き直す（既存のしくみ）
- GitHub への問い合わせ: Ready の PR とマージ済みの PR にも、イベントの一覧の問い合わせが 1 回増える（Risks で述べる）

## 設計

### Decisions

#### 区間の種類と担当

カードの表の 9 区間に、表に無い 3 つ（保留の 2 つと Draft に戻された後）を足して 12 種類にする。

| `kind`           | 区間             | 担当  | 始まり                                       |
| ---------------- | ---------------- | ----- | -------------------------------------------- |
| `idea`           | アイデアの滞留   | human | 起票（`created`）                            |
| `planning`       | 計画を書く       | ai    | 着手（`startedAt`）                          |
| `plan-review`    | 計画レビュー     | human | plan 提出 / 再提出                           |
| `plan-rework`    | 計画の差し戻し   | ai    | plan 否決                                    |
| `plan-held`      | 計画の保留       | human | plan 保留                                    |
| `implementing`   | 実装             | ai    | plan 承認（plan を飛ばすカードは着手）       |
| `verifying`      | 動作確認         | human | verify 提出 / 再提出                         |
| `verify-rework`  | 実装の差し戻し   | ai    | verify 否決                                  |
| `verify-held`    | 実装の保留       | human | verify 保留                                  |
| `readying`       | Ready にする     | ai    | verify 承認                                  |
| `pr-review`      | PR レビュー      | human | PR を Ready にした（`readyAt`）              |
| `draft-returned` | Draft に戻された | human | PR を Draft に戻した（`convertedToDraftAt`） |

区間の終わりは、次の区間の始まりである。マージ（`mergedAt`）と中止は、そこで今の区間を閉じるだけで次の区間を始めない。

保留は、作業者が否決を直しきれずに人の判断を待って止まった印なので、人の区間にする。
Draft に戻された後も、ループは Ready にし直さず人を待つ（`resolveHold`）ので、人の区間にする。

種類と担当の一覧は `src/shared/timeline.ts` に置く。グラフ（`bottleneck-chart`）が画面で区間の名前と色を引くので、web からも読める場所にする。

#### 出力の形

区間の配列を時刻の順に返す。差し戻しがあれば同じ種類の区間が何度も現れるので、種類をキーにした表にはしない。

```ts
interface TimelineSegment {
  readonly kind: TimelineKind;
  readonly owner: 'human' | 'ai';
  readonly start: string; // ISO 8601
  readonly end: string | null; // 今いる区間は null
}
```

今いる区間は `end: null` にし、導出は今の時刻を受け取らない。長さを出したい側は、`end` が `null` なら `generatedAt` までを数える。
こうすると導出は痕跡だけの純関数になり、同じ痕跡からいつでも同じ並びが返る。

区間の並びは次を満たす。テストで確かめる。

- 時刻の順に並び、隣り合う区間の `end` と次の `start` が等しい（隙間も重なりも無い）
- 長さが負の区間は無い。長さ 0 の区間（同じ時刻の痕跡が続いた）は落とす
- 同じ種類の区間が隣り合ったら 1 つにつなぐ（plan 提出の後に、否決を挟まず plan 再提出が来たとき）
- 終わったカード（マージ済み・中止）は最後の区間が閉じていて、`end: null` の区間を持たない

#### 導出のしかた — 痕跡を時刻の順に並べて、遷移の表で読む

痕跡を 1 つの列に並べ、時刻の順に読む。各痕跡が「次の区間の種類」を決め、そこまでの区間を閉じる。
同じ時刻の痕跡は、起票 → 着手 → `## レビュー` のエントリ（書かれた順）→ Ready → Draft へ戻す → マージ の順に並べる。

遷移は (ゲート, 種別) をキーにした表で引く。`if` を重ねると ESLint の `complexity: 12` に当たり、規則も読みにくくなる。

```
plan   提出 / 再提出 → plan-review
plan   否決          → plan-rework
plan   保留          → plan-held
plan   承認          → implementing
verify 提出 / 再提出 → verifying
verify 否決          → verify-rework
verify 保留          → verify-held
verify 承認          → readying（その時点で PR が Ready なら pr-review）
*      中止          → 閉じる（次の区間を始めない）
```

`## レビュー` は全部のエントリを時刻の順に読む。`currentEntries` や `latestGateEntry` は通さない。
これらは「今効いている判断」を選ぶために古いエントリを捨てるが、区間には古いエントリこそが要る。
たとえば「計画から立て直させる」（承認済みの計画への plan 否決）は、上の表のとおり `implementing` を閉じて `plan-rework` を始め、
計画を承認し直せばもう一度 `implementing` が始まる。この道をテストで確かめる。

中止の後にエントリが続いたら（中止を取り消すつもりで人が判断を書いた）、そのエントリから区間を再び始める。
マージの後の痕跡は読まない。

#### 表に収まらない痕跡の扱い

- **plan を飛ばすカード（`skipGates` に `plan`）:** plan のエントリが無く、着手した時点で実装中になる。
  着手から始まる区間を `planning` ではなく `implementing` にする。ステージの導出（plan を飛ばすと承認済み扱い）と揃える
- **verify を飛ばすカード:** verify のエントリが無い。`implementing` は Ready にした時刻で閉じ、`pr-review` が始まる。`readying` は現れない
- **verify 承認より先に PR が Ready になっている:** 人が GitHub で先に Ready にした場合である。
  承認の時点で PR が Ready なら（`readyAt` が承認以前で、その後 Draft に戻されていない）、`readying` を飛ばして `pr-review` にする。
  `readyAt` の痕跡そのものは、それが来た時点で今の区間を閉じて `pr-review` を始める（動作確認の途中で Ready にされたなら、そこから人のレビューに移ったと読む）
- **GitHub につながっていない（`mr` が無い）:** Ready とマージの時刻が無いので、最後のエントリから始まる区間が `end: null` のまま残る。
  計画が archive 済みでも、archive の時刻はワークツリーのファイルからは信用できないので使わない
- **マージされずに閉じた PR:** 閉じた時刻は引かない。最後の区間が開いたまま残る（Non-Goals）

#### 着手を戻したカード

着手を戻すと `startedAt` は消え、打ち直すと新しい時刻になる。前の `startedAt` は残らない。
ただし、着手を戻せるのは AI の成果物（計画ファイル・Draft の PR・`## レビュー` の提出）がまだ無いときだけである
（`resolveFloorStage` が `startedAt` を外したときに残るステージを下限にし、`droppableStages` は下限より前の列を出さない）。
したがって、失われるのは「1 度目の着手から着手を戻すまで」の `planning` だけで、その時間は `idea` に数えられる。
AI がまだ何も出していない時間なので、アイデアの滞留に数えても実態から大きくは外れない。今の `startedAt` をそのまま使う。

一方、`startedAt` が `null` のままエントリがあるカードは実際にある。
着手のボタンを押さずに、人がチャットのセッションで計画を書かせたカードである（今のボードでは `chat-decide` がそうで、`startedAt` が `null` のまま plan 提出からマージまで進んでいる）。
`startedAt` が最初のエントリより後にある痕跡は、通常の操作からは生まれない（DB を直接書き換えたか、古いデータを取り込んだとき）。
どちらも `startedAt` を無いものとして扱い、`idea` が最初の痕跡まで続く。
計画を書いた時間が `idea` に入るが、着手の印が無い以上、どこから AI が動いたかは痕跡から分からない。
「分からない」を表す種類を足す手もあるが、グラフの側で扱いが 1 つ増えるわりに得るものが少ないので採らない（PR で判断してほしい点に挙げる）。

#### PR を Ready にした時刻をどう引くか

`readyAt` は PR のイベント（`issues/{n}/events`）の `ready_for_review` から引く。
`convertedToDraftAt`（`convert_to_draft`）と同じ一覧なので、1 回の問い合わせから両方を取る。

- Draft と Ready を何度か行き来した PR では、**最後の** `ready_for_review` を採る。PR レビューの区間は最後に Ready にした時から数えるのが実態に合う。
  前の Ready の期間は、後に続いた `## レビュー` のエントリや `convertedToDraftAt` で別の区間に分かれる
- 作成時から Ready の PR は `ready_for_review` を残さない。Draft でない（open で Ready、またはマージ済みの）PR でイベントが無ければ、PR の作成時刻（`created_at`）を `readyAt` にする
- 今 Draft の PR で、一度も Ready にしていなければ `null`
- `convertedToDraftAt` の意味（今 open かつ Draft のときだけ値を持つ）は変えない。`resolveHold` がその前提で読んでいる

これまでイベントの一覧は open かつ Draft の PR にしか問い合わせていなかった。
`readyAt` は Ready の PR とマージ済みの PR でこそ要るので、PR の状態を問わずイベントの一覧を引く（Risks）。

`MrState` に `readyAt: string | null` を足し、控えのスキーマでは `.nullable()` の必須の項目にする（`.optional()` にしない）。
すると `readyAt` を持たない古い控えは読むときに検証で外れ、引き直される。
マージ済みの PR は `isSettled` で二度と引き直さないので、既にマージされたカードに `readyAt` を入れるには、この引き直しが唯一の道である。
変化の検出（`isSameMrState`）にも `readyAt` を足す。

#### どこに置き、どこへ出すか

- 導出の純関数は `src/board/services/stage-timeline.ts` に置く。入力は `created` / `startedAt` / `skipGates` / レビューのエントリ / PR の時刻（`readyAt` / `mergedAt` / `convertedToDraftAt`）で、`MrState` 全体には依存しない
- `get-board.query.ts` が `BoardCard.timeline` に載せる。`status --json` の `cards` は `BoardCard` から本文を除いたものなので、何も足さずに載る
- `src/web/types.ts` に型だけを写す。画面には出さない
- ループの監視役は `status --json` から `next` / `waiting` / `forge` だけを取り出して読む（`board-loop/SKILL.md`）ので、`cards` が太っても監視役の文脈には入らない

### Risks / Trade-offs

- **GitHub への問い合わせが増える。** CLAUDE.md は「Ready の PR やマージ済みの PR にイベントの問い合わせを足さない」と決め、PR #43 で問い合わせを減らしたばかりである。
  この計画はそれを覆し、PR の本体を引き直す（`enrich`）たびにイベントの一覧を 1 回（ページ数ぶん）引く。
  ただし `enrich` は指紋が変わったときにしか走らず、マージ済みの PR は `isSettled` で引き直さないので、増えるのはポーリングの回数ぶんではなく PR が変化した回数ぶんである。
  CLAUDE.md のこの決まりは書き直す
- **入れた直後に、控えがすべて 1 度ずつ引き直される。** 古い控えに `readyAt` が無いためで、マージ済みの PR も含む。カードの枚数ぶんの問い合わせが 1 度だけ出る
- **時間は実時間で数える。** 夜や休日も数えるので、人の区間が長く出る。これは意図どおりで、人がいないとループは止まることが数字に出る
- **区間の境目は痕跡が書かれた時刻であって、作業が始まった時刻ではない。** たとえば `implementing` はループが拾うまでの待ちを含む。待ちと作業を分けるのは `loop-activity` の仕事である
- **着手のボタンを押さずに進めたカード**（`startedAt` が `null`）では、`idea` が計画を書いた時間まで含む。ループに任せたカードは必ず着手を通るので、受け入れる

### Non-Goals

- 画面に区間を出すこと、区間の集計（中央値・ボトルネックの判定）。`bottleneck-chart` で行う
- AI の区間を「ループが拾うまでの待ち」と「作業者が動いていた時間」に分けること。`loop-activity` で行う
- 営業時間だけを数えること。実時間で数える
- マージされずに閉じた PR の、閉じた時刻を引くこと（`pr-closed-unmerged` のカードの領分）
- Draft と Ready の行き来をすべて区間にすること。引くのは最後の Ready と、今 Draft のときの最後に Draft へ戻した時刻だけ
- `ai-board status` のテキストの出力に区間を出すこと

## 動作確認の手順

共有の DB を汚さないよう、`AI_BOARD_DB` で別の DB を指す。区間を実データで見るために、マージ済みのカードを 3 枚、別の DB に取り込む。

- `verify-gate`（PR #37）: 計画の否決と再提出がある。動作確認のゲートができる前のカードなので、verify のエントリが無い
- `loop-respect-human`（PR #38）: 否決を挟まない verify 再提出がある
- `chat-decide`（PR #42）: 着手のボタンを押さずに進めたので、`startedAt` が `null`

```bash
cd .claude/worktrees/stage-timeline
npm run build
MAIN=$(git worktree list | head -1 | awk '{print $1}')
mkdir -p /tmp/ai-board-stage-timeline/cards
for id in verify-gate loop-respect-human chat-decide; do
  node dist/cli.js card show "$id" --root "$MAIN" > "/tmp/ai-board-stage-timeline/cards/$id.md"
done
export AI_BOARD_DB=/tmp/ai-board-stage-timeline/board.db
node dist/cli.js import --from /tmp/ai-board-stage-timeline/cards
node dist/cli.js status --json | jq '.cards[] | {id, stage, readyAt: .mrState.readyAt, timeline}'
```

1. 3 枚とも `mrState.readyAt` に、PR を Ready にした時刻が入る（GitHub の PR の画面のイベントと一致する）。PR の状態が引けていなければ、少し待って `status` を引き直す
2. `verify-gate` の `timeline` が `idea` → `planning` → `plan-review` → `plan-rework` → `plan-review` → `implementing` → `pr-review` と並ぶ。
   各区間の `start` が `created` / `startedAt` / `## レビュー` の時刻 / `readyAt` と一致し、`pr-review` の `end` がマージの時刻になる。`end: null` の区間が無い
3. `loop-respect-human` の `verifying` が、verify 提出から verify 承認までの 1 区間につながっている（再提出で分かれていない）。続いて `readying` → `pr-review` と並ぶ
4. `chat-decide` の `timeline` が `idea`（起票 → plan 提出）から始まり、`planning` が無い
5. `node dist/cli.js card create --title "ダミー" --id dummy-timeline < /dev/null` で作ったカードは、`timeline` が `idea`（`end: null`）の 1 区間だけになる
6. `node dist/cli.js --no-open` でサーバを起動し、`curl -s <サーバの URL>/api/board | jq '.cards[] | {id, timeline}'` が `status --json` と同じ並びを返す。確かめたらサーバを止める
7. 終わったら `/tmp/ai-board-stage-timeline/` を消す

## タスク

### 1. 区間の導出

- [x] `src/shared/timeline.ts` に区間の種類（12 種類）と担当（`human` / `ai`）の一覧、`TimelineSegment` の型を置く
- [x] `src/board/services/stage-timeline.ts` に、痕跡から区間の並びを返す純関数を書く。遷移は (ゲート, 種別) をキーにした表で引く。
      テストは `src/board/services/__tests__/stage-timeline.test.ts` に置き、次の道を確かめる:
      アイデアのまま / 着手したまま / 計画レビュー中 / 計画の否決と再提出 / 計画の保留 / 実装中 / 動作確認の否決と再提出 / 動作確認の保留 / Ready にする / マージ済み /
      計画から立て直させる（承認済みの計画への否決）/ 中止 / 中止の後にエントリが続く / plan を飛ばす / verify を飛ばす / verify 承認より先に Ready /
      Draft に戻された / GitHub につながっていない / `startedAt` が欠けた・最初のエントリより遅い / 同じ時刻の痕跡 / 否決を挟まない再提出。
      どのテストでも、並びの決まり（時刻の順・隙間も重なりも無い・長さ 0 を落とす・閉じたカードに `end: null` が無い）を確かめる

### 2. PR を Ready にした時刻

- [x] `MrState` に `readyAt` を足し、`github-client.ts` の `enrich` が PR の状態を問わずイベントの一覧を 1 回引いて `readyAt`（最後の `ready_for_review`、無ければ Draft でない PR は `created_at`）と `convertedToDraftAt`（今の意味のまま）を取るようにする。
      控えのスキーマ（`.nullable()` の必須）と `isSameMrState` に足し、`MrState` を組み立てているテストの fixture をすべて直す。
      github-client のテストに、Ready を行き来した PR・作成時から Ready の PR・マージ済みの PR・今 Draft の PR の `readyAt` を足し、snapshot のテストに `readyAt` の無い古い控えが外れることを足す

### 3. ボードと status に載せる

- [x] `BoardCard` と `BoardCardMr` に `timeline` と `readyAt` を足し、`get-board.query.ts` で組み立てる。`src/web/types.ts` に型を写す。
      e2e（`board.e2e.test.ts`）で `GET /api/board` の `timeline` を、status のテストで `status --json` の `cards[].timeline` を確かめる

### 4. ドキュメント

- [x] `CLAUDE.md`（レビュー要求の取得先の節のイベントの問い合わせの決まり、API の節）、`README.md`（`GET /api/board` の項目の一覧）、`docs/specs/board-stages/spec.md` に、区間の並びと `readyAt` を書く

### 5. 確かめる

- [x] `npm run typecheck && npm run lint && npm run format:check && npm test` と `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DB` の別の DB で試す
