---
id: stage-timeline
title: ユーザは、カードが各工程で人を待った時間と AI が使った時間を、残った痕跡から知りたい
created: '2026-10-31T06:51:59.603Z'
skipGates: []
branch: stage-timeline
mr: 44
---

## アイデア

カードが各工程にいた時間を、ボードに残った痕跡から導出する。区間には担当（人 / AI）を付ける。

| 区間 | 担当 | 始まり → 終わり |
| --- | --- | --- |
| アイデアの滞留 | 人 | 起票 → 着手 |
| 計画を書く | AI | 着手 → plan 提出 |
| 計画レビュー | 人 | plan 提出 → 承認 / 否決 |
| 計画の差し戻し | AI | plan 否決 → 再提出 |
| 実装 | AI | plan 承認 → verify 提出 |
| 動作確認 | 人 | verify 提出 → 承認 / 否決 |
| 実装の差し戻し | AI | verify 否決 → 再提出 |
| Ready にする | AI | verify 承認 → Ready |
| PR レビュー | 人 | Ready → マージ |

- **保存しない。** ステージと同じく、`## レビュー` の時刻・`created`・`startedAt`・PR の時刻から毎回導出する。導出は純関数にしてテストを書く
- **足りない時刻を引き足す。** PR を Ready にした時刻（GitHub の `ready_for_review` のイベント）を `MrState` に足す
- **時間は実時間で数える。** 夜や休日も数える。人の待ちが長く出ること自体が「人がいないとループは止まる」という気付きになる
- **出す先。** `GET /api/board` と `ai-board status --json` に区間の並びを載せる。グラフは `bottleneck-chart` で作る

## 背景

AI 駆動開発のどこがボトルネックか（人の判断待ちか、AI の作業か、差し戻しか）を、ボードから意識できるようにしたい。
研修では受講者がこのリポジトリを fork してループを回すので、回した結果を時間で振り返れることが学びの中心になる。
計測が後回しになると、それまでに回した周のデータが残らない。グラフより先に、区間を出せるようにしておく。

## 探索メモ

2026-10-31 の対話で決めたこと:

- AI の区間は、`loop-activity` の履歴で「ループが拾うまでの待ち」と「作業者が動いていた時間」に分ける（このカードでは分けない）
- 時間は実時間のまま数える
- 着手を戻すと前の `startedAt` は消える。打ち直したカードの扱いは計画で決める

## 動かす手順

共有の DB を汚さないよう `AI_BOARD_DB` で別の DB を指し、マージ済みのカード 3 枚（verify-gate / loop-respect-human / chat-decide）を取り込んで区間を見る。

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
node dist/cli.js card create --title "ダミー" --id dummy-timeline < /dev/null
node dist/cli.js --no-open    # 別の端末で curl -s <URL>/api/board | jq '.cards[] | {id, timeline}'。確かめたら止める
rm -rf /tmp/ai-board-stage-timeline
```

期待する結果:
1. 3 枚とも `mrState.readyAt` に GitHub の `ready_for_review` の時刻が入る
2. verify-gate: idea → planning → plan-review → plan-rework → plan-review → implementing → pr-review。pr-review の end がマージの時刻、`end: null` が無い
3. loop-respect-human: verifying が verify 提出 → verify 承認の 1 区間（再提出で分かれない）。続いて readying → pr-review
4. chat-decide: idea（起票 → plan 提出）から始まり planning が無い
5. ダミーのカードは idea（`end: null`）の 1 区間だけ
6. `GET /api/board` の timeline が `status --json` と同じ

## 自分で動かした結果

手順 1〜7 をすべて動かし、期待どおりだった（GitHub に接続した状態）。
- readyAt: #37 = 2026-10-30T00:40:05Z、#38 = 2026-10-30T05:30:28Z、#42 = 2026-10-31T06:36:25Z。`gh api issues/{n}/events` の `ready_for_review` と一致
- 各区間の start は created / startedAt / `## レビュー` の時刻 / readyAt と一致し、最後の pr-review の end は各 PR の merged_at と一致
- loop-respect-human は verify 提出 05:02:26 → verify 承認 05:29:39 の 1 区間（05:04:45 の再提出で分かれない）
- ダミーは `[{"kind":"idea","owner":"human","start":...,"end":null}]`
- サーバ（`--port 5793`）の `/api/board` と `status --json` の `{id, timeline}` を diff して一致。サーバは止めた

## 計画の手順から変わった点

- 作業用の DB は `/tmp/ai-board-stage-timeline/` ではなくセッションのスクラッチパッドに置いた（中身は同じ）。サーバは共有のサーバと重ならないよう `--port` を指定した
- AI レビューの直す指摘（中止の後に PR の痕跡で区間を開かない）を反映済み。単体テストで確かめた

## 確かめられなかった部分

- 画面には区間を出さない（グラフは bottleneck-chart）ので、画面の確認は無い
- 中止の後に Draft へ戻す道、Ready ↔ Draft を行き来した PR、作成時から Ready の PR は、実データでは確かめていない（単体テストのみ）
- GitHub に未接続のときの振る舞いは単体テストのみ

## 人に判断してほしいこと（AI レビューから）

- `src/board/services/github-client.ts` の `draftTransitionsOf()` は、作成時から Ready の PR の `readyAt` を `created_at` で補う。`stage-timeline.ts` の `toTraces()` はこれを時刻どおりに並べるので、Ready で作った PR では planning の途中（plan 提出より前）に短い pr-review が挟まり、以後 `prReady` が真のままになって verify 承認で readying が飛ばされる。verify を飛ばすカードでは implementing がマージまで続き、PR レビューの時間が AI の区間に数えられる。計画の Decisions どおりの振る舞いで、今のループは Draft で PR を作るので古いカードや手で作った PR でだけ起きる。このままにするか、補った `readyAt` を最後のエントリより前なら使わないなどの形にするかを決めてほしい
