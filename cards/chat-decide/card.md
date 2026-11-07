---
id: chat-decide
title: ユーザは、計画の承認などの判断を、画面を開かずにチャットから行いたい
created: '2026-10-31T05:46:52.845Z'
skipGates: []
branch: chat-decide
pr: 42
---

## アイデア

計画の承認・否決・中止、着手と着手を戻す、動作確認を飛ばす、アイデアの並べ替えを、ボードの画面を開かずに Claude Code のチャットから行えるようにする。
スキル `board-decide` から、起動中のサーバの人の API を叩く。チャットで頼めば Claude が呼ぶ。

## 背景

ループを回している Claude Code のセッションで作業の報告を受け、そのまま判断したい場面が多い。
いまは判断のたびにブラウザのボードへ移ってボタンを押す必要があり、報告を読む場所と判断する場所が分かれている。
一方で、承認 / 否決 / 中止は人の判断であり、エージェントが書けないことをボードの設計の柱にしている。
チャットからの書き込みは実際には Claude が行うので、エージェントが同じ手段で人の判断を書けないように境界を保つ必要がある。

## 探索メモ

2026-10-31 の対話で決めたこと:

- 境界は「人がこの会話で頼んだか」に引き、手順書の決まりで守る。当初は人だけが呼べるスキル（`disable-model-invocation`）にしたが、同日に緩めて Claude からも呼べるスキルにした。`ai-board card` の CLI には入口を足さない
- 書き込みは起動中のサーバの API を通す（人の API の検証をそのまま使う）
- 範囲は 承認 / 否決 / 中止、着手 / 着手を戻す、動作確認を飛ばす、並べ替え（rank と区切り線）
- サーバは起動時に自分の場所を書き残し、スキルはそれを読む（別のリポジトリのボードへの誤書きを防ぐ）
- 承認 / 否決 / 中止 / 着手を戻す は書く前に 1 回確認する。着手・並べ替え・動作確認を飛ばす はそのまま実行する
- 引数なしで呼んだら判断待ちを一覧し、出せる判断を選ばせる
- 計画や PR の中身はチャットに出さず、提出の本文と PR のリンクだけを出す

## 動かす手順

共有の DB を汚さないように、別の DB を指して試す。

```bash
cd .claude/worktrees/chat-decide && npm run build
export AI_BOARD_DB=/tmp/ai-board-chat-decide/board.db
node dist/cli.js card create --title "ダミーの計画レビュー" --id dummy-a < /dev/null
node dist/cli.js card create --title "ダミーのアイデア" --id dummy-b < /dev/null
printf '# ダミー\n\n- [ ] 何もしない\n' > .ai-board/plans/dummy-a.md   # コミットしない。最後に消す
node dist/cli.js --no-open --port 5690   # 別の端末で
```

1. `/tmp/ai-board-chat-decide/server.json` ができ、メインの `.ai-board/server.json` はできない。Ctrl+C で消える（`npm run dev` でも消える）
2. `node dist/cli.js status --json | jq '{server, waiting, ideas}'` で、`server.url`、dummy-a の `decisions`（承認 / 否決して差し戻す / 中止する）、`ideas`（区切り線を含む）が出る。`node dist/cli.js status` の 2 行目に「サーバ: <URL>」
3. 同じ `AI_BOARD_DB` を渡してワークツリーで Claude Code を起動し、スラッシュなしで頼む
   - 「判断待ちを見せて」→ dummy-a と出せる判断が選択肢で出る
   - 「dummy-a を否決して」→ 理由をチャットで聞き返され、答えた言葉がそのまま確認に出て、確かめた後に `## レビュー` に載る
   - 「dummy-b に着手して」→ 確かめずに計画提案中へ。「dummy-b の着手を戻して」→ 確認が出る
   - 「dummy-b を一番上へ」「区切り線を dummy-b の下へ」→ 画面の並びが変わる
   - 「dummy-a、よさそう」→ 承認と決めつけず聞き返す
   - サーバを止めて「dummy-a を承認して」→ 起動を促して止まる
4. 後片付け: `.ai-board/plans/dummy-a.md` と `/tmp/ai-board-chat-decide/` を消す

## 自分で動かした結果

- 1・2: 別の DB で起動して `server.json` ができ、メインには書かれないことを見た。SIGTERM（`ai-board`）と SIGINT（`npm run dev`）でファイルが消え、死んだ pid のファイルを置くと `server` が `null` になった
- 3 のうちスキルが叩く API 呼び出し（jq で組んだ本文）を curl で直接試した。理由なしの否決は 400 の本文がそのまま見え、引用符と改行を含む理由はそのまま `## レビュー` に載った。着手 / 着手を戻す / 動作確認を飛ばす / カードと区切り線の並べ替えはどれも 200 で、`status` の `ideas` が想定どおりに変わった
- 品質ゲート・カバレッジ・ビルドは通っている

## 計画から変わった点

- `server.json` の形と読み書きは `src/shared/` ではなく `src/infrastructure/server-info.ts` に置いた（画面からは使わないため）
- スキルはメインに固定せず、今いるチェックアウトの ai-board で `status` を読む（人の判断）。マージ前にワークツリーで試せる
- 開発用の `src/index.ts` も止まるときに `close()` を通す（人の判断）
- 否決の理由の聞き返しは AskUserQuestion ではなくチャットで行う。一覧から選んだ判断も手順 3 の確認を経る（AI レビューの指摘）

## 確かめられなかった部分

- 3 の、人がチャットで頼んだときにスキルが呼ばれるか、AskUserQuestion の確認の見え方、曖昧な言葉の扱い。私（このセッション）はスキルの変更前に起動しているので、新しい Claude Code のセッションで試す必要がある
- 画面への反映の見た目は見ていない（API の応答と `status` で確かめただけ）
