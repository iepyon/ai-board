---
id: skip-plan-needs-start
title: ユーザは計画を書かせたうえで計画レビューを飛ばしたい
created: '2026-10-31T09:05:47.460Z'
skipGates: []
branch: skip-plan-needs-start
mr: 49
---

## アイデア

ゲートを飛ばす宣言（`skipGates`）の意味を、「ログを見ずに通過済みとする」から「AI の提出を人の承認とみなす」に変える。
plan を飛ばすカードでも AI に計画を書かせ、提出した時点で計画レビューを通過させる。
あわせて、詳細パネルと `board-decide` のスキルから plan の宣言を出し入れできるようにする。

## 背景

計画は書かせたいが、読まずに通してよいカードがある。
夜間に `/loop` を回すときは、人が止まる場所を減らして、寝ているあいだに先まで進めてほしい。
plan を飛ばす宣言は、もともとこの用途のために入れたものである（`board-lanes` の計画）。

ところが、今の宣言はこの用途を満たしていない。
宣言のあるカードは着手した瞬間に plan ゲートが通過済みになり、計画提案中を飛ばして実装中に入るので、計画を書く手が一度も呼ばれない。
計画もブランチも Draft の PR もできないまま `implement` が渡され、`board-worker` はブランチが無いので止まる。
さらに、着手時刻が無くても実装中に入るので、人が着手を指示していないカードをループが選んでしまう。これは「`startedAt` は人が着手を指示する合図」という決まりとぶつかる。
今は plan の宣言を書く入口が API にしか無く、どのカードも使っていないので、実害は出ていない。

宣言を「提出を承認とみなす」と読めば、着手するまではエントリが無いので、plan ゲートは未提出のままアイデアに留まる。
着手すれば計画提案中で計画が書かれ、提出した時点で実装中に進む。
着手を戻せる範囲も普通のカードと揃い（提出の前は戻せて、後は戻せない）、人は後から否決や保留や承認を書いて止めることもできる。

## 探索メモ

- 変える所の見込み
  - `src/cards/services/review-log.ts` の `gateState`: 宣言のあるゲートでは 提出 / 再提出 を `approved` と読む。否決 / 保留 / 承認 はふつうに効く（今は宣言があればログを見ずに `approved`）
  - `src/board/services/stage-timeline.ts`: plan を飛ばすカードも着手から `planning` を通し、plan 提出から `implementing` にする（今は着手から `implementing`）
  - 詳細パネルに「計画レビューを飛ばす」のチェックボックスを足す（「動作確認を飛ばす」と同じ形で `withSkipGate` を使う）。`board-decide` のスキルにも足す
  - `decisionsFor` は宣言のあるゲートの承認 / 否決を隠している。宣言の意味が変わっても隠したままでよいかを決める
  - README、`docs/architecture.md`、`docs/specs/card-gate-skip` と `board-timeline`、`board-worker` の手順書
- verify の宣言は、意味を変えても振る舞いが変わらない見込み。verify を飛ばすカードの `board-worker` は動作確認を頼まずに Ready にするので、verify ゲートは未提出のまま 実装中 → PR中 へ進む（今は `approved` のまま同じ道を通る）
- 検討して採らなかった案
  - 実装中のルールに着手時刻の条件を足す: 下限がずれ、Draft の PR があっても着手を戻せてしまう
  - plan の宣言を着手済みのカードに限る: 事前に宣言できず、着手から宣言までのあいだにループが計画を書き始めうる
  - 未着手のカードでは plan の宣言を無いものとする: 着手の問題は直るが、計画が書かれない問題が残る
  - plan の宣言を無くす: 夜間に走り抜ける用途が無くなる
- 解説: https://claude.ai/artifact/GcLDKKVqdySnjuKrmea7Yc

- 動作確認の後に人が決めたこと（2026-11-01。AI レビューの「人に判断してほしいこと」3 件への回答）
  - 1（plan の再提出で人の verify 否決が消える）: この PR で直す。plan の 提出 / 再提出 を、plan ゲートが `none` か `rejected` のときだけに絞る。宣言の有無によらず全カードに効かせる（`src/cards/cli/card-cli.ts` の `runSubmit`）
  - 2（verify を飛ばすカードで「実装を直させる」を押すと、`revise-impl` が足した見送りと判断してほしい点が消える）: この PR で直す。ボタンは出したまま、verify を飛ばすカードの `revise-impl` の再提出の後に締めの段を通らないようにする。見送りを差し替えで消さず、PR のコメントを重ねず、`revise-impl` の判断してほしい点が人に届く形にする
  - 3（`board-decide` で宣言を入れるとその場で承認になる）: この PR で直す。宣言を入れると、待っている提出がそのまま承認と読まれるときだけ確かめる（計画レビューのカードに `plan`、動作確認のカードに `verify` を入れるとき）。アイデアと計画提案中のカードに入れるときは確かめない

- 2 回目の動作確認の後に人が決めたこと（2026-11-01）: 1:a の絞り込みで、中止したカードを AI の `plan 再提出` で再開できない場合がある（plan ゲートが submitted / approved / held のまま中止したカード）。AI の書き込みで人の中止を打ち消せないほうがよいので、今のままとする

## 手順（実装を経た後）

共有の DB を汚さないよう、`AI_BOARD_DB` でワークツリーの外の DB を指し、GitHub には繋がずに試す。メインのボードのサーバ（5673）は止めずに、別のポートで起動してよい。

1. ワークツリーで `npm run build`。空のディレクトリ `$R` を作って `git init` し、`AI_BOARD_DB=$DB node dist/cli.js card create --title 試し --id try-skip --root $R < /dev/null`
2. `AI_BOARD_DB=$DB node dist/cli.js --root $R --port 5791 --no-open` で起動し、`http://127.0.0.1:5791` の詳細パネルを見る
   - ゲートの欄に「計画レビューを飛ばす」と「動作確認を飛ばす」の 2 つのチェックボックスと説明文がある
   - 「計画レビューを飛ばす」に印を入れても、カードはアイデアに留まる
3. `card submit try-skip --reason 試し --root $R` が「plan の提出は着手したカードにしかできません」で失敗し（終了コード 1）、`## レビュー` に何も増えない
4. 画面で着手を押すと計画提案中に入る
5. 3 と同じ `card submit` が通り、計画レビューを通らずに実装中へ進む
6. `curl -s http://127.0.0.1:5791/api/board | jq '.cards[] | select(.id == "try-skip") | .timeline | map(.kind)'` が `["idea", "planning", "implementing"]`
7. 「計画レビューを飛ばす」の印を外すと plan ゲートが提出済みに戻り、計画提案中に落ちる。入れ直すと実装中に戻る
8. `card hold try-skip --gate plan --reason 試し` は否決が無いので失敗する。画面で「計画から立て直させる」（plan の否決）を押すと計画提案中に落ち、`card submit try-skip --resubmit --reason 試し` で実装中へ戻る
9. サーバを止める

## 自分で動かした結果

画面の代わりに、詳細パネルと同じ `PATCH /api/cards/:id`（`skipGates` / `startedAt`）と `POST /api/cards/:id/reviews` を自分で起動したサーバ（別の DB、別のポート）に送って確かめた。

- 2: `skipGates: ["plan"]` を入れても stage は `idea`、timeline は `["idea"]`
- 3: 未着手のカードへの `card submit` は終了コード 1、`plan 提出` は増えない
- 4: 着手後は stage `planning`、次の一手は `plan`（着手が指示され、計画がまだ無い）
- 5・6: `card submit` が通り、stage `impling`、gates `{plan: approved, verify: none}`、次の一手は `implement`、timeline は `["idea", "planning", "implementing"]`
- 7: 宣言を外すと gates.plan が `submitted`、stage `planning`（次の一手は無し）。入れ直すと `impling` に戻る
- 8: 否決の前の `card hold --gate plan` は「保留は plan の最新の判断が否決のときにしか書けません」で失敗。plan 否決で stage `planning`・次の一手 `revise-plan`、`card submit --resubmit` で `impling`・次の一手 `implement` に戻る。2 回目の否決 → 再提出でも同じ
- 品質ゲートと `npm run build` は通っている

## 計画の手順から変わった点

- 5673 はメインのボードのサーバが使っているので、止めずに `--port 5791` で起動し、`--root` を空の作業ディレクトリにした（`npm run dev` / `dev:web` の代わりに `dist/cli.js` のサーバ）
- GitHub に繋がないと `ai-board status` の `next` は常に null になる（`buildStatusReport` の決まり）。次の一手は、`status --json` のカードを `pickNextAction` に直接渡して確かめた
- 7 の印を外したとき、timeline は今の宣言で過去を読むので `["idea", "planning", "plan-review"]` になる（計画の Risks の「宣言は今の値で過去を読む」のとおり）

## 確かめられなかった部分

- 詳細パネルの見た目（2 つのチェックボックスと説明文の並び、印を入れたときに保存中は押せなくなること、ボタンの出方）。ブラウザでは見ていない。コンポーネントのコードを読んだだけである
- 判断のボタンの出方（plan を飛ばすカードが実装中で止まったときの「計画から立て直させる」、verify を飛ばすカードが Draft に戻されたときの「実装を直させる」）。画面では見ていない

## 人に判断してほしいこと（AI レビューより）

1. plan を飛ばすカードでは、AI が着手済みのカードにいつでも `plan 再提出` を書ける（`card-cli.ts` の `runSubmit` は着手しか見ない）。その 再提出 が plan の承認と同じ区切りになり、`plan 提出 → verify 提出 → verify 否決 → plan 再提出` で verify が `none` に戻る。人の `verify 否決` を AI の 1 回の CLI 呼び出しで消せる。plan の 提出 / 再提出 を「plan ゲートが none か rejected のときだけ」に絞るか（すべてのカードか、宣言のあるカードだけか）、手順書の決まりに任せるかを決めてほしい
2. verify を飛ばすカードで「実装を直させる」を押すと、`revise-impl` の `verify 再提出` が承認と読まれ、締めの段へ進む。締めの段は PR の本文の `## 見送った AI レビューの指摘` 節を計画の見送りで差し替えるので `revise-impl` が足した見送りが消え、`### 人に判断してほしいこと` の PR コメントも 2 回目が書かれ、再提出の理由に書いた判断してほしい点は判断待ちの区画に出ない。この道はこの PR でボタンを出したことで初めて通る。この PR で直すか（計画の Non-Goals に踏み込む）、別のカードにするかを決めてほしい
3. `board-decide` のスキルの「計画レビューを飛ばす」は「確かめるか: しない」だが、`plan 提出` 済みで計画レビューにいるカードに入れると、その場で計画を承認したのと同じになる。計画レビューにいるカードに入れるときだけ確かめるか、今のままにするかを決めてほしい
