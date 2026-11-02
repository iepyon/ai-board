# 0021. ループのサブエージェントを入れ子にせず、監視役が status の next.step を見て直接立てる

- 状態: 採用（一部を [0023](0023-three-loop-roles.md) が置き換え）
- 日付: 2026-11-01
- 置き換え元: [0012](0012-loop-supervisor-and-fresh-subagent.md)・[0015](0015-separate-ai-reviewer.md)（一部）
- 置き換え先: [0023](0023-three-loop-roles.md)（一部）

## 状況

[0015](0015-separate-ai-reviewer.md)（`loop-impl-review`）で、`implement` の手を受けた `board-worker` が、タスクを倒す段では `board-task` を、
レビューの段では `board-reviewer` を入れ子で立てる形にしていた。手元のセッションでは動いた。

2026-11-01 にクラウドのセッションで `/loop 5m /board-loop` を回したところ、`node-lts` の `implement` で `board-worker` が止まった。
クラウドのセッションではサブエージェントが `Agent` の道具を持てず、`board-task` を立てられなかった。
`board-worker.md` は道具を絞っていないので、定義を直しても解決しない見込みだった。
止まったカードは次の周でも `next` に選ばれるので、ループは毎周同じところで止まり、そのたびに約 7.6 万トークンを使った。
スマホの Claude Code からクラウドでボードを回す使い方（[0019](0019-cards-on-data-branch.md)）では、実装中のカードを 1 枚も進められなかった。

`loop-impl-review` では、`status` にカードのブランチの計画を `git show` で読ませる案を、
サーバと `status` に git の読み取りを持ち込むこと、「計画ファイルがあれば列が立つ」読み方と二重になることを理由に退けていた。
同じ計画の Risks で「入れ子が使えなければ諦めてよい」としていたのは、タスクごとの報告が監視役の文脈に積もらないことだった。

## 決定

**サブエージェントを立てるのは監視役（会話のトップ）だけにし、サブエージェントの中からサブエージェントを立てない。**

- `implement` の中の段は `ai-board status` が決め、`next.step`（`task` / `review` / `close` / `null`）として監視役に渡す。
  段は計画の状態（archive 済み・未チェックのタスク・`## AI レビュー` 節の有無）から純関数 `resolveImplStep` で決める
- 監視役は `next.step` を見て、`task` なら `board-task`、`review` なら `board-reviewer`、`close` と `null` なら `board-worker` を直接立てる。`prompt` は 3 行のままで `step` は書かない
- **ブランチの計画を読むのは `status` の CLI だけで、`next` に選ばれた 1 枚だけにする。** サーバ・`GetBoardQuery`・`stage-resolver.ts` には持ち込まない。**段はステージではない**
- 読み方は `git show <ref>:<path>` を `cli-runner` 経由で、ローカルのブランチ → `origin` の追跡ブランチの順に読む。`git fetch` はしない。読めなければ段は `null` で、`status` は失敗させない
- `next.action` の種類は増やさず、`NextAction` に `step` を足すだけにする
- 入れ子で `board-worker` が行っていた結果の確かめは、受けた側が自分で行い、満たせなければ `止まった` と報告する
- **入れ子が使える手元のセッションでも同じ手順で回す。** 手順を 2 つ持たない

## 検討した代案

- **`board-worker` が段を決めて報告で返し、監視役が次の周で立てる** — 段を決めるだけの起動が挟まり 1 タスクあたりのトークンがほぼ倍になる。報告の文面から次の渡し先を読むことにもなる
- **`board-task` / `board-reviewer` が自分で段を判定し、違えば止まる** — 監視役がどちらを立てるかを決められないので、結局ほかの案が要る
- **`task` / `review` を `next.action` の種類にする** — `review-log.ts` / `card-cli.ts` / `dashboard-sections.ts` に手の種類が広がり、段は `implement` の中の区切りという語の使い方とも食い違う
- **入れ子が使えるセッションでは入れ子の手順を残す** — どちらの道を通ったかで確かめ方が変わり、サブエージェントの定義も二重になる
- **`status` で `git fetch` する** — `status` のたびにネットワークに出る

## 結果

- 手元でもクラウドでも同じ手順でループが回る。どのサブエージェントも `Agent` の道具を要しない
- `status` に git の読み取りが入った。範囲は CLI の `next` の 1 枚に限り、ボードの画面とステージの導出は変わらない
- ローカルのブランチが無く追跡ブランチが古いと古い段が出うる。受けた側が前提の食い違いで止まり、人が `git fetch` するか手で渡す
- 結果の確かめが書いた本人によるものになった。`board-reviewer` が計画のほかのファイルを直してコミットしても締めの段は気づかず、人が PR の差分で見る
- 1 タスク 1 手になり、タスクの数だけ報告が監視役の文脈に積もる
- 直後の `task-count-codeblock`（PR #59）で、段の判定と進捗バーはコードブロックの中のチェックボックスと見出しを数えないように変わった
- `board-task` を立てる段と 1 手 1 タスクは [0023](0023-three-loop-roles.md) が置き換えた（`task` も `board-worker` に渡す）。
  監視役だけがサブエージェントを立てること、段を `status` の `next.step` で渡すことは今も効いている

## 根拠

- 計画: `.ai-board/plans/archive/loop-flat-subagents.md`
- 前の判断: `.ai-board/plans/archive/loop-impl-review.md`
- コミット: `e8f3c1f` 計画から実装中の段を決める resolveImplStep を足す
- コミット: `58c9e9c` カードのブランチの計画を git show で読むリポジトリを足す
- コミット: `84da7fb` status の implement で、カードのブランチの計画から next.step を埋める
- コミット: `cbc673d` board-loop の監視役が next.step で board-task / board-reviewer を直接立てる形にする
- コミット: `78c654b` 実装中の段の判定がコードブロックの中のチェックボックスと見出しを数えないようにする
- PR: #56、#59
