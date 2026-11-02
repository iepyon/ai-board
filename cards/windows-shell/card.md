---
id: windows-shell
title: ユーザは、Windows でも手順書のシェルを書き換えずにループを回したい
created: '2026-10-31T06:52:00.276Z'
skipGates: []
branch: windows-shell
mr: null
---

## アイデア

スキルと作業者の手順書（`.claude/skills/` と `.claude/agents/`）を、Windows でも書き換えずに回せるようにする。

- 手順書の中の `jq`（8 か所）や `sed` を、`ai-board` のサブコマンドか `node` の 1 行に置き換える。例えば `status --json` から要る項目だけを取り出すのは、`ai-board status` の側で出せるようにする
- 想定するシェルは、Windows の Claude Code が使う Git Bash にする。パスの書き方（`/c/...` と `C:\...`）で壊れないかを確かめる
- CI に Windows の行を足し、品質ゲートとビルドが Windows でも通ることを確かめる

## 背景

研修の受講者には Windows の人がいる。
今の手順書は macOS の端末を前提に書いてあり、`jq` は Git Bash に入っていない。
受講者がそこで止まると、ハーネスの中身ではなく環境の問題で研修の時間が消える。

## 探索メモ

2026-11-02 の調査（クラウドの Linux から読んだだけ。Git Bash の実機では確かめていない）。

### 分かったこと

- **手順書で Git Bash に無いのは `jq` だけ。** `jq` は `.claude/skills/board-decide/SKILL.md` の 1 ファイルだけに 9 行（`status --json` の絞り込みと、人の API に送る JSON の組み立て）。`board-loop` と `board-worker` は `jq` を使っていない
- `sed`・`grep`・`diff`・`sort`・`date -u`・`mktemp`・プロセス置換 `<(...)` は Git for Windows に同梱されるので、Git Bash ならそのまま動く見込み（`board-loop/SKILL.md:72` の `sed -n`、`board-worker.md:166` の `norm()` など）
- **カードに無い問題 1: 改行コード。** `.gitattributes` が無い。Git for Windows の既定（`core.autocrlf=true`）で clone すると CRLF になり、`npm run format:check` が全ファイルで落ちる見込み（prettier の `endOfLine` の既定は `lf`）
- **カードに無い問題 2: ブラウザを開く処理。** `src/cli-main.ts` の `openBrowser` は Windows で `start` を `spawn` するが、`start` は cmd の組み込みなので ENOENT になる見込み。失敗は子プロセスの `error` イベントで出るので `try/catch` では捕まらず、リスナーが無いとサーバが落ちうる
- 大丈夫そうなところ:
  - 外部コマンドは `execFile`（shell 無し）で、`gh` と `git` は `.exe` なのでそのまま動く
  - `git worktree list` が返す `C:/...` の形のパスは、Git Bash でも node でも使える
  - 計画のタスクは `\r?\n` で分割し、`## レビュー` のエントリの見出しは正規表現の末尾が `\s*$` で、`\r` に耐える。ただし CRLF のカード本文を CLI が書き戻したときの挙動は確かめていない
- **テストを Windows の CI で通すのは重い。** テストは 48 ファイル。うち 5 つが `/tmp` などの POSIX 形式のパスを直接書き、9 つが `git` を実際に走らせる。`chmod` を使うテストも 1 つある（`data-store.test.ts`）

### 人に判断してほしい点（計画で決める）

1. **Windows で動かす範囲。** 案 A: 手順書と、サーバ・CLI の実際の動作だけ。案 B: A に加えて CI の Windows の行で品質ゲートを全部通す（テストの修正が要る）。勧めは、まず A で出して B は別のカードに分ける
2. **`jq` の置き換え方。** `status` の絞り込みは `ai-board status` 側に出力の選択を足す。判断の JSON の組み立ては `node -e` の 1 行にする。判断を書く部分を `ai-board` の CLI に足すと、エージェントが使う CLI に人の判断の入口ができてしまうため（CLAUDE.md の書き込み境界）
3. **`sed` やその他のコマンドは直さない。** Git Bash にあるので要らない（カードの「`sed` を置き換える」は外す）
4. **カードに無い 2 件を含める。** `.gitattributes`（`* text=auto eol=lf`）の追加と、`openBrowser` の修正（Windows では `cmd /c start "" <url>`、`error` のリスナーを付ける）
5. **実機の確認。** クラウドの環境では Git Bash を確かめられないので、動作確認のゲートで人（か研修の講師）が Windows で 1 周回す
