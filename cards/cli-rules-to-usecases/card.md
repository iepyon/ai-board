---
id: cli-rules-to-usecases
title: AIエージェントは、ボードの拒否のルールを CLI の外の usecase と純関数で読み、確かめたい
created: '2026-11-06T02:35:47.202Z'
skipGates: []
branch: cli-rules-to-usecases
pr: 88
---

## 背景

画面とサーバを外したので（ADR 0017）、usecase を使うのは CLI だけになった。
ところが、ハードルールのうち「提出は着手済みで plan が未提出か否決のときだけ」「保留は否決のときだけ」という拒否は、`src/cards/cli/card-cli.ts` の private な関数（`submitRefusal` / `gateRejected`）にある。
拒否は `Refused { message: string }` という文字列のエラーで返しており、「エラーは discriminated union」の規約からも外れている。
`decide` の「出せない判断は拒む」検査（`decisionsFor` / `droppableStages` / アイデアの表に入っているかの確認）も CLI の中にあり、`transact` の外で読んだボードで検査して、書き込みだけを `transact` の中で行っている。
`appendReviewCommand` はゲートの状態を検査し直さないので、push が拒否されて書き込みをやり直すとき、検査は古いボードのままになる。
加えて、トランザクションの包み方が `createTransactionalCardDependencies`（サーバのために作ったもの）と card-cli の `transactCard` の 2 通りあり、同じ `CardWriteRefusedError` を二重に捕まえている。
画面をゼロから作り直すときに拒否のルールをそのまま使えるよう、ルールを CLI の外へ出しておきたい。

## アイデア

CLI の中身を 3 つに分け、置き場所を決め直す。

- 引数の解析と出力の整形は CLI に残す。
- データを読まないと決まらない拒否は usecase にする。提出と保留は別々の usecase（`SubmitReviewCommand` / `HoldReviewCommand`）にし、`kind` は中で固定する。`appendReviewCommand` に拒否を足したり、`kind` を引数に取る汎用の usecase にしたりはしない（AI と人の境界が、構造ではなく引数の値で決まるようになるため）。エラーは `NotStarted` / `PlanGateNotOpen { state }` / `HoldRequiresRejected` のような種に分け、CLI の `switch` で 1 行に直す。
- 導出済みの `Board` だけで決まる `decide` の拒否は、`src/shared/dashboard-sections.ts` と同じく純関数に切り出す。検査を `transact` の中でやり直すかどうかもここで決める。
- トランザクションの包み方を 1 つにまとめる。

pr-cli・status-cli・loop-cli は、すでに薄いか、重い部分が純関数なので対象にしない。

## 探索メモ

- 一緒に直す古いコメント: card-cli の docstring「UI と HTTP API からだけ行える」、decide-cli の docstring「画面のボタンと同じ usecase を、サーバと同じ組み立てで」、`DECIDE_USAGE` の「画面で押せない判断は拒む」。
- 強制する場所が移るので書き直す記述: `CLAUDE.md` の「`ai-board card` の CLI はこれを構造で強制している」、`docs/architecture.md` の 89 行目と 239 行目（「CLI の検査（`submitRefusal` など）」）。
- 使う側が CLI だけなので、層を増やすと遠回りになるのが代償。
