# ループのサブエージェントを計画・実装・レビューの 3 つに絞り、実装は 1 回で倒し切る

## この計画で使う言葉

- **監視役**：`/board-loop` のスキルを動かすセッション。`ai-board status --json` の `next` を読み、サブエージェントに 1 手を渡す。
- **実装の役**：この計画で、今の `board-task` と `board-worker` を 1 つにまとめた役。名前は `board-worker` を残す（Decisions）。
- **節**：計画の `## タスク` を `### <番号>. <題>` の見出しで区切った範囲。今は `board-task` が 1 回の起動で倒す単位だが、この計画で「止まってよい区切り」に変える。
- **品質ゲート**：`npm run typecheck && npm run lint && npm run format:check && npm test`。通らないままコミットしない（`CLAUDE.md` のハードルール）。

## 提案

### Why

2026-11-02 に `loop-task-batch` を board-loop で回したとき、`board-task` は 9 回立ち（タスク 8 つと AI レビューの直す指摘 1 つ）、
1 回 7.7 万〜8.7 万トークン、合計約 74 万トークンだった。カード 1 枚の全体は約 112 万トークンである。
タスクはどれも手順書を数か所直す小さなもので、使ったトークンのほとんどは計画・`CLAUDE.md`・手順書の読み直しだった。

PR #63 で 1 回の起動が 1 タスクから 1 節に広がったが、読み直しは節の数だけ残る。
さらに締めの段（見送った指摘を PR に写して動作確認を頼む）にも別の `board-worker` が立ち、同じものを読み直す（約 7.6 万トークン）。

まっさらな文脈にしたいのは、別のカードの文脈と、実装からレビューへの引き継ぎだけである（`loop-task-batch` の判断）。
同じカードのタスク同士、またレビューの直す指摘と締めの段の間では、文脈を持ち込む方が有利である。

### What Changes

使う人から見た変化は次のとおり。

- ループのサブエージェントは `board-planner`（計画）/ `board-worker`（実装）/ `board-reviewer`（レビュー）の 3 つになる。`board-task` は無くなる
- `implement` の手でタスクが残っていれば、`board-worker` が 1 回の起動で残りの節を上から順に全部倒す。
  品質ゲートとコミットは今と同じく節の終わりごとに 1 回で、節ごとに push する
- 節は「止まってよい区切り」になる。文脈が膨らんだら（自動の要約が入ったら）、`board-worker` は今の節を終えたところで自分から止まり、次の起動に残りを渡す。
  次の起動は計画の `[x]` とコミットから続きの節を選ぶ
- `## AI レビュー` 節がある計画でタスクが残っていれば（レビューの直す指摘）、`board-worker` はそれを倒した後、同じ起動のまま締めの段（見送った指摘を PR に写し、動作確認を頼む）へ進む
- 監視役の渡し先は、`next.step` が `review` のときだけ `board-reviewer`、それ以外の `implement` / `revise-impl` / `ready` はすべて `board-worker` になる

流れは次のようになる（今は `board-task` が節の数だけ立ち、締めに別の `board-worker` が立つ）。

```
board-planner（plan）→ 人の計画レビュー → board-worker（全部の節を倒す）→ board-reviewer
  → board-worker（直す指摘を倒し、動作確認を頼む）→ 人の動作確認 → board-worker（ready）
```

変わらないこと:

- 1 周で渡す手は高々 1 つ。`next.action` の 5 種類と、`next.step` の値（`task` / `review` / `close` / `null`）とその意味
- 監視役は計画を読まない。`prompt` は `cardId` / `action` / `MAIN` の 3 行
- 実装する役とレビューする役は別のサブエージェントのまま。AI レビューは 1 回だけ
- 節の終わりごとの品質ゲートとコミット、ゲートが通らないときに順番を直してよい範囲（移す・合わせる・入れ替える）
- `board-planner` の計画の書き方（節の切れ目はゲートが通るところ）
- ステージの導出、`status` の判定のコード、サーバ、画面、データ用ブランチの形

### Impact

- ループ: `.claude/agents/board-worker.md`（中心。`board-task.md` の手順を取り込む）、`.claude/agents/board-task.md`（消す）、
  `.claude/agents/board-planner.md`、`.claude/agents/board-reviewer.md`、`.claude/skills/board-loop/subagent-rules.md`、
  `.claude/skills/board-loop/SKILL.md`、`.claude/skills/board-decide/SKILL.md`
- ドキュメント: `README.md`（AI ループの節）、`docs/architecture.md`（`status` の段の渡し先）
- コード: docstring だけ。`src/board/services/impl-step.ts` / `next-action.ts` / `src/board/cli/status-describe.ts` の `board-task` への言及を直す。判定は変えない

## 設計

### Decisions

#### 実装の役は `board-worker` の名前で残し、`board-task` を消す

候補は 2 つあった。

1. `board-worker` に `board-task` の手順を取り込み、`board-task.md` を消す
2. 新しい名前（`board-implementer` など）で 1 つにまとめ、両方を消す

1 を採る。

- `board-worker` は既に `implement` / `revise-impl` / `ready` の 3 つの手を受けており、渡し先の表は「`review` だけ `board-reviewer`」と縮めるだけで済む
- `status-describe.ts` の「`null` は `board-worker` に渡す」や README・architecture の記述をそのまま使え、直す範囲が小さい
- 名前を変えると、監視役の手順 0（動いているサブエージェントを名前の頭で見る）の判定も変わる。1 なら `board-task-` を外すだけで済む

#### `implement` の手は、受けた段から締めの段まで続けて進める

`board-worker` は `implement` の手で計画を読み、次のように進める。

| 計画の状態                                          | すること                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `plans/archive/` にある                             | `ai-board pr ready <mr>` だけをやり直す（今のまま）                                    |
| 未チェックのタスクがあり、`## AI レビュー` 節が無い | 節を上から順に倒す。全部倒したら `進めた` で止まる（次の手で `board-reviewer` が立つ） |
| 未チェックのタスクがあり、`## AI レビュー` 節がある | 節を上から順に倒す。全部倒したら同じ起動のまま締めの段へ進む                           |
| 全部倒れていて、`## AI レビュー` 節が無い           | レビューの段。何も変えずに `止まった` で止まる（段の食い違い。今のまま）               |
| 全部倒れていて、`## AI レビュー` 節がある           | 締めの段（今のまま）                                                                   |

- レビューの段の前では必ず止まる。実装した文脈のままレビューに進まないためで、カードの「レビューは別の役のまま」を守る
- 直す指摘を倒した後は、もう一度のレビューをしない（今の決まり）ので、締めの段へ続けてよい。締めの段で読むのは計画の `## AI レビュー` 節と PR の本文で、どちらも直したばかりの文脈にある
- `next.step` の値は変えない。`task` を受けた `board-worker` が締めまで進むことがあるだけで、`status` は計画の状態をそのまま映す

#### 節は「止まってよい区切り」にし、止まる目安は自動の要約にする

論点の候補は、節の数・変えたファイルの量・自動の要約が入ったか、だった。自動の要約を採る。

- 1 回の起動で、残りの節を上から順に倒す。節ごとに品質ゲート → コミット → push（今の `board-task` の 5・6 を節ごとに繰り返す）
- 節を 1 つ倒して push し終えた区切りで、その起動の中で自動の要約が入っていたら、そこで止まって `進めた` と報告する。
  要約が入っていなければ次の節へ進む
- 節の数やファイルの量は、計画レビューで人が決めた節の大きさ（`board-planner` の目安）で既に抑えてある。重ねて数で縛ると、小さな節が多い計画で止まりすぎる
- 要約は、読んだコードや決めた事柄が抜け落ちる合図である。次の節を要約の後の文脈で始めるより、まっさらな起動で計画とコミットから読み直す方が確かである
- 止まった後の続きは、今と同じく計画の `[x]` とコミットで決まる。次の起動は最初の未チェックのタスクを含む節から始める。特別な引き継ぎは作らない

途中で止まる条件（何をすればよいか決まらない、Decisions と食い違う、ゲートが通らない）は今の `board-task` のまま、今の節についてだけ働く。
戻すのは今の節の変更だけで、前の節のコミットは残る。

#### 監視役の渡し先

| `next.action` / `next.step`                                                  | 渡す先           |
| ---------------------------------------------------------------------------- | ---------------- |
| `plan` / `revise-plan`                                                       | `board-planner`  |
| `implement` で `next.step` が `review`                                       | `board-reviewer` |
| それ以外（`implement` の `task` / `close` / `null`、`revise-impl`、`ready`） | `board-worker`   |

手順 0 の「動いているサブエージェント」の名前の頭は `board-planner-` / `board-worker-` / `board-reviewer-` の 3 つにする。
マージの時点で動いている `board-task-` は無い（監視役は手順 0 で待ってから次を渡すため、マージ前に立った `board-task` は先に終わる）。

#### 計画の節の決まりはそのまま使う

`board-planner` の決まり（切れ目はその節までを倒し終えたらゲートが通るところ、節の途中は壊れてよい、節の大きさの目安、節 1 つでもよい）は変えない。
切れ目でゲートが通ることは、止まってよい区切りであるための条件でもある。言い回しだけ「`board-task` が 1 回で倒す単位」から
「`board-worker` が止まってよい区切り」に直す。

#### `revise-impl` と `ready` は変えない

`revise-impl` は否決の理由から直す小さな手で、自分で AI レビューをかける今の形のままにする。`ready` も今のまま。

### Risks / Trade-offs

- **1 回の起動の文脈が膨らむ。** 節の大きさは計画レビューで抑え、要約が入ったら区切りで止まる。
  要約が入るまでは膨らみ続けるので、1 回のトークンは今の 1 節より大きくなる。合計で減ることを、次のカードで測って確かめる（動作確認の手順の 5）
- **自動の要約が入ったかを、サブエージェントが自分で見分けられない場合がある。** 見分けられなければ最後まで続ける。
  計画の `[x]` と節ごとのコミットがあるので、要約の後でも続きは読める（`loop-task-batch` で `[x]` を節の途中で付けるようにした理由と同じ）
- **途中で落ちると、未コミットの変更が残る。** 今と同じく、次の起動は手を付けずに止まり、人がワークツリーを片付ける。前の節のコミットは残るので、失うのは今の節の分だけである
- **締めまで続けると、直す指摘を倒した後の差分を誰も見ない。** 今も同じ（AI レビューは 1 回だけで、`board-task` の後にレビューは無い）。人の動作確認と PR で見る
- **`board-worker.md` が長くなる。** 今の 134 行と `board-task.md` の 172 行を合わせる。重複する部分（入力、ワークツリーに入る、報告）を 1 つにし、
  `implement` の中を「節を倒す」「締めの段」の小節に分けて読みやすくする
- **このカード自身は今の定義で進む。** サブエージェントの定義はメインのチェックアウトから読まれるので、このカードの実装は節ごとに `board-task` が倒す。
  そのため、この計画の節はどれも単独でゲートが通るように切ってある（手順書・ドキュメント・docstring だけの変更）

### Non-Goals

- `next.step` / `next.action` の値を足す・減らす・変えること。`impl-step.ts` の判定を変えること
- 1 つのサブエージェントで複数のカードを進めること。監視役の「1 周で渡す手は高々 1 つ」を変えること
- AI レビューを 2 回にすること、レビューを実装の役に寄せること
- `revise-impl` / `ready` / `revise-plan` の中身を変えること
- 止まる目安を数（節の数・ファイルの数・トークン）で決めること
- アーカイブ済みの計画（`plans/archive/`）を書き直すこと

## 動作確認の手順

変えるのは手順書・ドキュメント・docstring だけで、サブエージェントとスキルの定義はメインのチェックアウトから読まれるので、通しの流れはマージ後にしか確かめられない。

マージ前:

1. ブランチの差分を読み、`.claude/agents/board-task.md` が無く、`.claude/agents/board-worker.md` の `implement` に
   「残りの節を上から順に倒し、節ごとにゲート・コミット・push する」「要約が入ったら節の区切りで止まる」
   「`## AI レビュー` 節があれば倒し終えた後に締めの段へ進み、無ければ止まる」が書かれていることを見る
2. `grep -rn 'board-task' .claude README.md docs CLAUDE.md src` が何も返さないことを見る（archive の計画は除く）
3. `.claude/skills/board-loop/SKILL.md` の渡し先が、`review` だけ `board-reviewer`、ほかの実装の手は `board-worker` になっていることを見る
4. `npm run typecheck && npm run lint && npm run format:check && npm test` が通る

マージ後（手元かクラウドのセッション）:

5. 節が 3 つ以上ある計画の実装中のカードで `/loop 5m /board-loop` を回し、次を見る
   - タスクを倒す段で立つのが `board-worker-` 1 つで、PR のコミットが節ごとに 1 つずつ並ぶ
   - 倒し終えると `board-reviewer-` が立ち、その後の `board-worker-` 1 つが直す指摘を倒して動作確認を頼む（`verify 提出` がカードに出る）
   - 実装の手（タスクを倒す段から動作確認を頼むまで）のトークンの合計（完了の通知に出る）を、`loop-task-batch` の約 74 万 + 締めの 7.6 万と比べる。
     結果はカードの `## 探索メモ` か PR のコメントに残す
6. 自動の要約が入るほど大きい計画で回したとき、`board-worker` が節の区切りで `進めた` と報告して止まり、次の `board-worker` が続きの節から始めることを見る
   （起きなければ、起きなかったと記録する）

## タスク

この計画のタスクは今の定義（節ごとに `board-task` が倒す）で実装されるので、どの節の後でも品質ゲートが通るように切ってある。

### 1. 共通の決まり

- [x] `.claude/skills/board-loop/subagent-rules.md` の「呼び名」の表を 3 つの役（`board-planner` / `board-worker` / `board-reviewer`）に直し、`board-task` の行を消して、
      `board-worker` の行を「実装中の手（`implement` / `revise-impl` / `ready`）を受ける。`implement` では残りの節を倒し、`## AI レビュー` 節があれば締めの段まで進む」に直す。
      「段」「まっさらな文脈」の説明を、1 つの `board-worker` が節をまたいで同じカードの文脈を持ってよく、レビューの前でだけ必ず別の起動に分ける形に直す。
      「4 つのサブエージェント」などの数を 3 つに直す
- [x] `subagent-rules.md` の「タスクの数え方と `## AI レビュー` 節」の節の説明を、「`board-task` が 1 回の起動で倒す単位」から
      「`board-worker` がゲートを通してコミットする単位で、止まってよい区切り」に直す。節の見出しを変えるときは `subagent-rules.md` を参照する側を grep で直す

### 2. 実装の役

- [ ] `.claude/agents/board-worker.md` の `implement` を書き直し、今の `board-task.md` の 2〜6（節を選ぶ、タスクの範囲、上から倒して `[x]`、節の終わりのゲートと順番の直し、コミット前の確かめとコミットと push）を取り込む。
      節を倒し終えるごとに次の節へ進む繰り返しにし、要約が入っていたら節の区切りで止まる決まりと、倒し終えた後に `## AI レビュー` 節があれば締めの段へ進み、無ければ `進めた` で止まる決まりを足す。
      段の表（Decisions の「`implement` の手は、受けた段から締めの段まで続けて進める」）を差し替え、「タスクを倒す段は `board-task` に渡す。ここに来たら止まる」を消す
- [ ] `board-worker.md` の frontmatter の description・冒頭の説明・報告（倒した節の数と題、止まった区切り、締めまで進んだか）・ハードルール
      （節の外の `[x]` に触らない、順番を直してよい範囲、節の途中でコミットしない、を `board-task.md` から移す）を直し、`.claude/agents/board-task.md` を `git rm` で消す

### 3. 計画を書く側とレビューする側

- [ ] `.claude/agents/board-planner.md` の `plan` の 2 の節の説明を「`board-worker` がゲートを通してコミットする単位で、止まってよい区切り」に直し、`board-task` への言及を `board-worker` に直す
- [ ] `.claude/agents/board-reviewer.md` の `board-task` への言及（直す指摘を倒す役、まとめて倒れる前提）を `board-worker` に直し、
      直す指摘を倒した `board-worker` が同じ起動で締めの段へ進むことを、見送った指摘の書き方の説明に合わせて書く

### 4. 監視役とドキュメント

- [ ] `.claude/skills/board-loop/SKILL.md` の description、冒頭のサブエージェントの列挙、`implement` の渡し先の表（`task` を `board-worker` に）、
      「タスクを倒し終えるまで、節ごとに新しい `board-task` が立つ」の段落、手順 0 の名前の頭、手順 3 の `subagent_type` の決め方を 3 つの役の形に直す。
      `.claude/skills/board-decide/SKILL.md` のサブエージェントの列挙から `board-task` を外す
- [ ] `README.md` の AI ループの節（渡し先の列挙、段の表の `task` の行、節の説明、まっさらな文脈の説明、作業中の判定の名前の頭）と、
      `docs/architecture.md` の「監視役は `task` なら `board-task`」を 3 つの役の形に直す。
      `src/board/services/impl-step.ts` / `next-action.ts` / `src/board/cli/status-describe.ts` の docstring の `board-task` を `board-worker` に直す。
      `grep -rn 'board-task' .claude README.md docs CLAUDE.md src` で残りが無いことを確かめる
