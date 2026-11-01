---
id: server-shutdown-sse
title: ユーザはブラウザでボードを開いたままでも、ai-board のサーバを Ctrl+C ですぐに止めたい
created: '2026-10-23T05:53:26.040Z'
skipGates: []
branch: null
mr: null
---

## アイデア

ブラウザでボードを開いたままでも、SIGINT / SIGTERM でサーバがすぐに終わるようにする。

- **止める順を変える。** 先に `server.close()` で新しい接続の受け付けを止め、そのあとで SSE の接続を閉じる
- **残った接続を切る。** `server.closeAllConnections()`（Node 18.2 以降）で、keep-alive の接続も含めて切る
- **最後の保険。** 数秒たっても終わらなければ、`process.exit` で終える
- **テスト。** SSE の接続を張ったまま `RunningServer.close()` を呼び、決まった時間内に解決することを確かめる

## 背景

2026-10-23 にサーバを起動し直そうとしたとき、SIGTERM を送っても 15 秒以上終わらず、SIGKILL で止めるしかなかった。
そのときプロセスにはブラウザとの接続が 1 本だけ残っていた（`lsof` で ESTABLISHED が 1）。
ブラウザを開いていなかった回は、SIGTERM ですぐに終わっていた。

`cli-main.ts` の `shutdown` は `server.close()` の完了を待ってから `process.exit(0)` する。
`server.close()` は既存の接続がすべて閉じるまで解決しないので、接続が 1 本でも残ると永遠に終わらない。
ボードは開きっぱなしで使うものなので、Ctrl+C で止まらないのは日常的に困る。
SIGKILL で止めても DB は WAL なので壊れないが、監視の後始末（chokidar、DB の watcher）が飛ばされる。

## 論点

- **原因の特定。** `RunningServer.close()`（`src/server.ts`）は `sse.close()` で SSE のレスポンスを `end()` してから、
  `await watcher.close()` を挟んで `server.close()` を呼ぶ。考えられる原因は 2 つあり、どちらかはまだ確かめていない
  - `sse.close()` から `server.close()` までの間に、ブラウザの EventSource が `retry: 3000` で張り直し、
    新しい SSE の接続が `clients` に入る。その接続は誰も閉じない
  - SSE を `end()` したあとも、keep-alive の接続が残る（Node 19 以降の `server.close()` はアイドルな接続を閉じるはずだが、
    ブラウザの別のリクエストが使っている接続は閉じない）
- **待つ時間。** 強制終了までの猶予を何秒にするか。ポーリング中の `gh api` の実行を待つ必要は無い
- **`process.exit` の置き場所。** 猶予の処理を `cli-main.ts` の `shutdown` に置くか、`RunningServer.close()` に持たせるか。
  テストから呼べる方に置く
