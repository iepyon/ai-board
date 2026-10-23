---
name: board-loop
description: ai-board のボードを読み、AI が進めてよいカード（計画提案中 / 実装中）の次の 1 手を、まっさらな文脈の作業者（board-worker のサブエージェント）に渡す。手は、計画を書いて Draft の PR を出す、否決された計画を直す、計画のタスクを 1 つ倒す、倒し終えたら Ready にする、のどれか 1 つ。`/loop 5m /board-loop` で間隔運転する。「ボードを進めて」「次のカードをやって」「board-loop」で使う。
---

# board-loop — 次の 1 手を作業者に渡す監視役

このスキルを動かすセッションは **監視役** である。監視役は次の一手を選んで作業者に渡し、返ってきた報告を人に伝えるだけで、カードの作業は自分でしない。
作業は `.claude/agents/board-worker.md` の作業者（サブエージェント）が、まっさらな文脈で行う。
前のカードで読んだコードや決めた事柄を、次のカードの作業に持ち込まないためである。

1 周で作業者に渡す手は **高々 1 つ**。何を渡すかは自分で選ばず、`ai-board status --json` の `next` に従う。
人の判断（着手・承認・否決・中止・並び順・マージ）は代行しない。

## 0. 作業中の作業者がいないかを見る

`ListAgents` で、名前が `board-worker-` で始まる作業者が動いていないかを見る。
動いていれば「作業中: <カード ID>（<いつから>）」とだけ伝えて、この周は終わる。

作業者はバックグラウンドで動くので、作業中にも次の周が来る。このときの `status` はまだ同じ `next` を返すため、
ここで止まらないと 2 人目の作業者が同じカードに入る。
「さっき渡した」という自分の記憶ではなく `ListAgents` を見る。自動の要約で記憶が落ちても判定が変わらないようにするためである。

長く動き続けている作業者は、固まっている見込みがある。報告にいつから動いているかを書き、人が `TaskStop` で止められるようにする。

## 1. ボードを読む

メインのチェックアウト（以下 `$MAIN`）で `status` を読む。`dist/` が古ければ先にビルドする。
`status --json` は全カードの全項目を出すので、`next` / `waiting` / `forge` だけを取り出して読む（監視役の文脈を膨らませないため）。

```bash
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
# dist/cli.js が無いか、HEAD のコミットより古ければビルドする（stat の書式は OS で違うので node で比べる）
if ! node -e 'const fs=require("fs");const [f,t]=process.argv.slice(1);process.exit(fs.existsSync(f)&&fs.statSync(f).mtimeMs/1000>=Number(t)?0:1)' \
    "$MAIN/dist/cli.js" "$(git -C "$MAIN" log -1 --format=%ct)"; then
  npm --prefix "$MAIN" run build
fi
node "$MAIN/dist/cli.js" status --json --root "$MAIN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({next:j.next,waiting:j.waiting,forge:j.forge}))})'
```

## 2. 止まる条件（何も渡さずに報告して終わる）

- `status` が失敗した。「不明なオプションです: status」なら、`$MAIN` のコードが `ai-board status` を持たない古いものである。
  `$MAIN` を `origin/main` に更新してビルドし直すよう人に頼む（自分では更新しない）
- `next` が `null`。`waiting` のカードを人に知らせて終わる。
  `forge.status` が `connected` でないとき（`gh` の未ログイン、問い合わせの失敗、`config.yaml` に `github:` が無い）も、
  `status` は `next` を `null` にする。PR の状態が引けないと、計画レビュー / PR中 のカードが手前の AI の列に落ちて見えるため。
  このときは `forge` の理由を人に知らせる

## 3. 作業者に渡す

`Agent` を次の形で呼ぶ。

- `subagent_type`: `board-worker`
- `name`: `board-worker-<next.cardId>`
- `description`: `<next.action> <next.cardId>`
- `prompt`: 次の 3 行だけを書く。要約や補足を足さない

```
cardId: <next.cardId>
action: <next.action>
MAIN: <$MAIN>
```

作業者はカード本文・計画ファイル・PR を自分で読み直す。監視役が要約を添えると、監視役の文脈にある前のカードの前提がそこから漏れる。
人がこのセッションで口頭で伝えた補足は作業者に届かない。補足はカード本文の `## 探索メモ` に書いてもらう。

渡したら「<カード ID> の <手> を作業者に渡した」とだけ伝えて、この周は終わる。

## 4. 作業者の報告を伝える

作業者が終わると、完了の通知が届く。この手番では、作業者の報告を 3 行以内に縮めて人に伝えるだけにする。
次の作業者は渡さない（次の手は次の周の cron が選ぶ）。作業者の主張を確かめ直すこともしない。次の周の `status` が実態を映す。

進められずに止まったカード（ゲートが通らない、未コミットの変更が残っている）は、次の周でも `next` に選ばれ、ループはそこで止まり続ける。
人が直すまで他のカードには進まない。報告ではそのカードと、人に何をしてほしいかをはっきり書く。

## ハードルール

- 1 周で作業者に渡す手は高々 1 つ。作業中の作業者がいれば渡さない
- カード本文・計画ファイル・差分・PR を読まない。作業者に渡すのはカード ID・手の種類・`$MAIN` だけ
- `Agent` が失敗しても、自分で作業せずに止まって報告する
- `subagent_type: "fork"` を使わない。fork は監視役の会話をすべて引き継ぐので、作業者を切り離す意味が無くなる
- `/code-review` も監視役では走らせない（差分が監視役の文脈に入るため）。作業者の中で行う
- カードへの書き込みはしない。`startedAt` / `rank` / `skipGates` や承認 / 否決 / 中止を書かず、PR をマージしない
