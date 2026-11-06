---
id: forge-unset-decide
title: ユーザは、GitHub を設定していない研修のボードでも、判断を書いてループを進めたい
created: '2026-11-06T12:35:43.307Z'
skipGates: []
branch: null
mr: null
---

## アイデア

GitHub を設定していない（`config.yaml` に `github:` が無い）ボードでも、人の判断（着手 / 着手を戻す / 承認 / 差し戻し / 中止）を書け、ループの次の一手が出るようにする。

- **未設定と届かないを分ける。** GitHub が「未設定」（`disabled`）なら PR はそもそも無いので、判断の検査と次の一手を通す。「設定してあって届かない」（`error`）なら、今どおり拒み、次の一手も出さない
- **導出の核は変えない。** `stage-resolver.ts` に条件は足さない。変えるのは判断の検査（`decision-guards.ts`）と次の一手の出し方（`get-status.query.ts`）の入口だけにする

## 背景

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。
今は GitHub が「接続済み」でないと、`decide` の判断を `ForgeUnavailable` で拒み（`src/board/services/decision-guards.ts` :33・:61）、`status` の `next` を null にする（`src/board/usecases/queries/get-status.query.ts` :56）。
この守りは、PR の状態が引けないと計画レビューや PR中 のカードが手前の列に落ちて見え、判断を取り違えるのを防ぐためにある（`src/board/cli/decide-cli.ts` :319）。
ただ、`github:` を書かない（未設定）ときも同じに扱うので、研修で GitHub を外すと着手も承認もできず、ループも動かない。
未設定なら PR は無く、手前に落ちて見える心配も無い。

## 探索メモ

- 2026-11-06、`offline-data-mode` の調べで見つけ、人の答えで別のカードにした。`offline-data-mode` は書き込みの手元モードに絞る
- `offline-snapshot-view` は「ループと判断の検査は今のまま（つながっていないときは次の一手を出さない）」としている。届かない（`error`）ときの扱いはそれと揃え、このカードは未設定（`disabled`）だけを扱う
- 計画で決めること
  - 未設定のボードで、計画の手（Draft の PR を出す）をループがどう進めるか。`branch-plan-review` とのかみ合わせ
  - 途中で `github:` を足したり外したりしたときに、既に PR を持つカードが手前の列に落ちて見えないか（`mr` を持つカードがあれば拒む、など）
  - ADR 0007（board-decide）・ADR 0003（GitHub を gh に委ねる）への書き足し
- 2026-11-06 の追加の調べ（コードを読んで確かめた）
  - **GitHub に届かない環境は `error` ではなく `disabled` になる。** 起動時の `checkAuth` は `gh api repos/<owner>/<repo>` を 1 回投げて確かめ（`src/board/services/github-client.ts` :102）、失敗すると `unavailableMrStateProvider` が `{ status: 'disabled', kind: 'github', reason }` を返す（`src/board/services/mr-state-provider.ts` :40）。`error` は `checkAuth` が通った後のポーリングの失敗だけ（`src/infrastructure/forge-poller.ts` :113）。`github:` が無いときだけが `kind: null` の `disabled`（`src/board/composition.ts` :106）
  - 状態は 4 つ: ① 未設定（`disabled`・`kind` null）② 使えません（`disabled`・`kind` github・`reason` あり。オフライン・gh が無い・未ログイン）③ 接続済み（`connected`）④ エラー（`error`）。「`disabled` なら通す」と書くと②も通ってしまう
  - **未設定のボードでは、判断と `next` を通しても、ループは計画の手で止まる。** 計画の手は `git push` と `ai-board pr create --draft` で Draft の PR を出す（`.claude/skills/board-loop/plan.md` :84）。PR を飛ばしても、計画はメインのチェックアウトから見えないので「提出したのに計画も Draft の PR も見えない」で止まる（`branch-plan-review` の範囲）。実装の締め（Ready にする）や PR中 も PR を前提にし、マージ済みは計画の archive でだけ立つ
  - **途中で `github:` を外すと、PR を持つカードが手前の列に落ちて見える。** `disabled` では全カードの `mr` が null になる（`src/board/usecases/queries/get-board.query.ts` :82）。PR の状態を引けないカード（`mrFailure`）は `droppableStages: []` にして動かさせない仕組みがあり、`mr` を持ち計画が archive されていないカードにも同じ扱いが使える見込み
  - 「`github:` の無いリポジトリでも `next` を出さない」は `get-status.query.ts` :46〜49 の docstring にある判断で、ADR には無い。変えるなら ADR を書くか書き足す
- 人の答え（2026-11-06、チャットで）
  - 通すのは①未設定（`kind` が null の `disabled`）だけにする。②使えません（`github:` を書いたまま届かない・gh が無い・未ログイン）と④エラーは今どおり拒み、`next` も出さない
  - 範囲は判断の検査と `status` の `next` を通すところまで。このカードだけでは 1 周は回らない。計画の手を未設定に合わせる（push と PR を飛ばし、ブランチの計画で計画レビューを立てる）のは `branch-plan-review` などの別カードに任せる
  - `mr` を持ち計画が archive されていないカードは、そのカードだけ判断を拒み、次の一手でも選ばない。ほかのカードは進める
  - 研修で GitHub を外す方法は、fork のデータ用ブランチの `config.yaml` に `github:` を書かない運用とし、手元で上書きする口は足さない
