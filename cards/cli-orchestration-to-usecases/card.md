---
id: cli-orchestration-to-usecases
title: AIエージェントは、判断の書き込みとボードの見せ方の段取りを、CLI の外の usecase と query から呼びたい
created: '2026-11-06T03:57:20.419Z'
skipGates: []
branch: null
mr: null
---

## 背景

`cli-rules-to-usecases`（PR #88）で、拒否のルールは CLI の外へ出た。提出と保留の検査は usecase に、人の判断の検査は `decision-guards.ts` の純関数になり、書き込みの包み方も `transactCardWrite` の 1 つにまとまった。
それでも、ルールを使って「どう書くか」「何を見せるか」を組み立てる部分は、まだ CLI の中に残っている。
`ai-board decide` の、ボードを導出し、検査し、書き、コミットのメッセージを決めるまでの段取りは、`src/board/cli/decide-cli.ts` の `decide()` の補助関数にある。
`status` が見せる形（判断待ち・作業中・アイデアの表・次の一手。`buildStatusReport` と `withImplStep`）は、`src/board/cli/status-cli.ts` にある。
ボードの組み立て（PR の状態の取得元・控え・書き戻しの組み方。`assembleBoard`）と `decide` の依存の組み方は `src/cli-main.ts` にあり、CLAUDE.md の「依存はコンテキストごとの `composition.ts` で組む」から外れている。
`card` のコミットのメッセージ（`data: <id> に plan 提出 を足す` など）も CLI が決めている。
画面はいずれゼロから作り直す（ADR 0017）。そのとき API から同じ判断を書き、同じ形でボードを見せるには、今はこれらを写すことになる。
CLI に残すのを引数の解析と人に読める文への直しだけにし、画面と API からも同じ段取りを呼べるようにしておきたい。

## アイデア

振る舞いを変えずに、次の 4 つを CLI の外へ移す。CLI の出力・終了コード・コミットのメッセージは変えない。

1. `decide` の段取りを、`src/board/usecases/commands/` の承認・否決・中止・着手・着手を戻す・飛ばす宣言・並べ替えの usecase にする。
   ボードの導出・検査（`decision-guards.ts`）・書き込み・コミットのメッセージを usecase が持ち、`Result<_, DecideError>` を返す。`decide-cli.ts` は引数を解析し、エラーを文に直すだけにする
2. `status` の見せる形を、`src/board/usecases/queries/` の query（例えば `getStatusQuery`）にする。`status-cli.ts` は整形（人向けの数行と `--json` / `--only`）だけにする
3. `assembleBoard` と `decide` の依存の組み方を、`src/board/composition.ts` へ移す
4. `card` のコミットのメッセージを、1 と同じく usecase の側へ寄せる

## 探索メモ

- 次の 2 つは小さいので、このカードに入れるか別にするかを計画で決める
  - `card` の CLI に `updateCardMetaCommand` がまだ渡っていて、型の上では `startedAt` / `skipGates` も書ける。ブランチの紐付けを専用の usecase にすれば外せる（PR #88 の計画で「今回は入れない」とした件）
  - `decide()` は `transact` の `op` の中でボードを導出するので、計画ファイル名の不正などで出る読み飛ばしの警告が、push が拒否されてやり直すたびに重ねて出る（PR #88 の AI レビューで見送った指摘）
- 次は、このカードでは決めない。画面を作り直すときに決める
  - 常駐するサーバでのロックと取り直し。今の `transact` は同じプロセスの中で 1 列に並ぶので、そのまま使える見込み
  - どこから GitHub を引くか、`127.0.0.1` にだけ bind すること（ADR 0017）
  - エラーを HTTP のステータスへ変えること（API の側の仕事。人に読める文への直しは CLI に残してよい）
