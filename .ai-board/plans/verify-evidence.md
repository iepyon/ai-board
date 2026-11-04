# Ready の前に AI が CI を確かめ、PR中 で読む証拠を表にそろえる

## この計画で使う言葉

- **証拠:** 締めの段で AI が PR の本文の `## 動作確認の結果` に書くもの。人は PR中 でこれを読み、必要なら手で動かし、差分を読んでマージする
- **チェック:** PR の最新コミットに付く CI の結果。GitHub の Checks API（`check-runs`。GitHub Actions など）と Commit Status API（`status`。外部の CI など）の 2 系統がある
- **fix の確かめ:** バグを直すとき、足したテストが直す前のコードで落ち、直した後で通ることを確かめること

## 提案

### Why

`merge-verify-into-pr` で、人の確かめは PR中 の 1 回にまとまり、AI は締めの段で動かした結果を PR の本文に書くようになった。
それでも次が足りない（2026-11-04 にカードを整理して人と確かめた）。

- **CI の結果をどこからも見ていない。** `.github/workflows/ci.yml` は PR で走るが、ループは見ずに Ready にする。CI が赤のまま人の番になりうる
- **証拠の形がそろっていない。** 箇条書きで、走らせたものと走らせていないものの区別が書き手まかせになっている
- **直したことを確かめていない。** fix のテストが、直す前のコードで本当に落ちるかを見ていない。落ちないテストは直したことの証拠にならない

人が 2026-11-04 に決めたこと（カードの探索メモ）:

- CI は締めの段で Ready の前に AI が確かめる。ボードの表示とポーリングは増やさない（ボードのバッジは `pr-checks` に戻した）
- CI が赤なら締めの段で直してから Ready。走っている間は待ち、直せない・終わらないなら止まって人に伝える
- `## 動作確認の結果` は「確かめたこと / コマンド / 結果」の表にそろえる
- fix の確かめは fix のときだけ書く
- スクリーンショットは外した（`pr-screenshots`）

### What Changes

- **`ai-board pr checks <n> [--wait] [--timeout <秒>] [--json]` を足す。** PR の最新コミット（`head.sha`）のチェックを `check-runs` と `status` の両方から全件引き、1 つの表にまとめて出す
  - 全体の判定は `passed`（すべて成功・中立・飛ばした）/ `failed`（1 つでも失敗・取り消し・時間切れ・要対応）/ `pending`（1 つでも走っている）/ `none`（チェックが 1 つも無い）
  - 終了コードは `passed` / `none` が 0、`failed` が 1、`pending` が 2（`--wait` で待ち切れなかったときも 2）
  - `--wait` は、`pending` の間と、push の直後でチェックがまだ 1 つも無い間（猶予の時間まで）、CLI の中で間隔を置いて引き直す。手順書のシェルで `sleep` しない
- **締めの段（`implement.md` の 2.2）に CI の確かめを足す。** 動作確認を動かした後、`ai-board pr checks <mr> --wait` を走らせる
  - `failed`: 落ちたチェックのログを読み、締めの段のまま直す（品質ゲート → `fix:` のコミット → push）。もう一度 `--wait` で確かめる。直すのは 2 回まで
  - `pending`（待ち切れなかった）、または 2 回直しても `failed`: Ready にせず `止まった` で手を終え、どのチェックがどうだったかを人に伝える
  - `passed` / `none`: 証拠を書いて archive し、Ready にする
- **`## 動作確認の結果` を表にそろえる。** 節の中身を次の 3 つにする
  - 人が動かすときの手順（今どおり）
  - 「確かめたこと / コマンド / 結果」の表。結果は `通った` / `落ちた` / `走らせていない` のどれか。品質ゲートと CI（チェックごと）も行に入れる。`走らせていない` 行には理由と、確かめるのに何が要るかを書く
  - 計画の手順から変わった点
- **fix の確かめを足す。** タスクを倒す段で、バグの直し（AI レビューの直す指摘のうち誤った振る舞いを直すもの、計画で fix と書いたタスク）は、先にテストを書いて落ちることを確かめてから直す。
  確かめたことはコミットの本文に 1 行で残し、締めの段で表の行にする（締めの段は別の周のことがあるので、文脈ではなくコミットから読む）

### Impact

- `src/board/services/pr-checks.ts`（新規。チェックのまとめと判定の純関数）とテスト
- `src/board/services/github-client.ts`（`check-runs` と `status` を引く口）、`src/board/cli/pr-cli.ts`（`checks` のコマンド）とテスト
- `.claude/skills/board-loop/implement.md`（締めの段・タスクを倒す段）、`rules.md`（ハードルールの「締めの段はコードに触らない」）、`plan.md`（動作確認の手順の書き方）
- `README.md`、`docs/architecture.md`、`docs/adr/0005-verify-in-pr.md`
- ステージの導出・ボードの表示・ポーリングは変えない

## 設計

### Decisions

#### チェックは `check-runs` と `status` の両方を合わせる

GitHub Actions は `check-runs` に、外部の CI は `status` にだけ書くことがある。片方だけ見ると、落ちたチェックを見落とす。
`check-runs` は `commits/{sha}/check-runs` を `--paginate` で全件、`status` は `commits/{sha}/status`（コンテキストごとの最新）を引く。
同じ名前が両方にあっても別の行として出す（名前の付け方は CI ごとに違い、突き合わせると取り違えるため）。

判定の対応:

| 出どころ     | 走っている                     | 成功とみなす                      | 失敗とみなす                                                        |
| ------------ | ------------------------------ | --------------------------------- | ------------------------------------------------------------------- |
| `check-runs` | `status` が `completed` でない | `success` / `neutral` / `skipped` | `failure` / `cancelled` / `timed_out` / `action_required` / `stale` |
| `status`     | `pending`                      | `success`                         | `failure` / `error`                                                 |

判定とまとめは純関数（`src/board/services/pr-checks.ts`）に置き、`gh` の出力から切り離してテストする。

#### 待つのは CLI の中で、上限つき

`--wait` は CLI の中で 15 秒おきに引き直す。`--timeout` の既定は 900 秒（今の CI は 1 本数分。2 つの Node の版で走る）。
push の直後は、チェックがまだ登録されていないことがある。`--wait` のときは、チェックが 1 つも無い状態を最初の 120 秒は `pending` として待ち、過ぎたら `none` とする。
シェルで `sleep` しないのは、環境によって前景の `sleep` が止められることがあり、手順書を OS ごとに書き分けたくないためである。

#### CI は Ready の前に確かめ、archive の前に通す

締めの段は「動かして確かめる → CI を確かめる（直す）→ 証拠を書く → archive → Ready」の順にする。
archive より前に通すのは、締めの段の途中で止まったときに計画が archive に移っていると、次の周が「archive 済み（Ready だけをやり直す）」と読み、CI を確かめずに Ready にしてしまうためである。
archive のコミット（計画ファイルの移動だけ）にも CI が走るが、その結果は待たない。品質ゲートを手元で通してからコミットするので、コードの結果は変わらない。

#### 締めの段で直してよいのは CI を通すためだけ

今の締めの段は「コードに触らない」決まりで、AI レビューの後に差分を変えないことを守っている。
CI が赤のときだけ、落ちたチェックを通すための直しを許す。直した差分に AI レビューはやり直さない（直す指摘を倒した後と同じ扱い）。
直したことは表の行と、コミット（`fix:`）に残り、人は PR中 で差分を読む。
2 回直しても通らなければ、直し方に人の判断が要る見込みが高いので止まる（AI が同じところで止まり続けたら上限で止める、という `loop-retry-limit` のアイデアと同じ考え）。

#### fix の確かめはコミットの本文に残す

タスクを倒す段と締めの段は別の周（別の文脈）になりうるので、確かめた事実は文脈ではなく git に残す。
コミットの本文に `直す前に落ちることを確かめた: <テストの名前>` の行を書き、締めの段で `git log origin/main..HEAD` からその行を拾って表に入れる。
どれが fix かは、AI レビューの直す指摘のうち「誤った振る舞い」に当たるもの（`rules.md` の指摘の分け方）と、計画で fix と書いたタスクで決める。新しい機能のテストには求めない。

#### チェックが 1 つも無いリポジトリでは Ready にしてよい

CI を持たないリポジトリでもループが止まらないよう、`none` は Ready にしてよい。表の CI の行に `走らせていない（チェックが無い）` と書く。

### Risks / Trade-offs

- **締めの段が長くなる。** CI を待つ数分〜15 分のあいだ、本筋のセッションは手を進めない。間隔運転の周は手番が終わるまで届かないので、重ならない
- **API の問い合わせ。** 15 秒おきに 2〜3 本を、待つ間だけ引く。15 分待っても 200 本ほどで、ポーリングの上限（`forge-poll-budget`）よりずっと少ない
- **CI のログを読む口。** 落ちたチェックの原因は、チェックの URL と `gh api` の `check-runs/{id}` の `output` で読む。GitHub Actions のジョブのログ全文は、クラウドでは読めないことがある。読めなければ止まって人に伝える
- **直しが AI レビューを通らない。** CI を通すための直しは AI レビューを経ずに入る。直しは 2 回までで、表とコミットに残る

### Non-Goals

- ボードのカードに CI の結果を出すこと（`pr-checks`）
- 画面のスクリーンショット（`pr-screenshots`）
- ステージの導出に CI の結果を使うこと（CI が赤でも列は変わらない）
- ブランチ保護の必須チェックだけを見分けること（すべてのチェックを見る）
- PR中 になった後に CI が赤になったときの扱い（人の番。PR を Draft に戻すか、`pr-feedback-ai-turn` で考える）

## 動作確認の手順

1. `npm run build` のあと、このリポジトリの PR（例: このカードの PR）で `node dist/cli.js pr checks <n>` を走らせる。`check-runs` の CI（Node の版ごとの 2 行）が名前・結果・URL つきで出て、全体の判定と終了コードが合う
2. `node dist/cli.js pr checks <n> --json` が、行と全体の判定を JSON で出す
3. push の直後に `node dist/cli.js pr checks <n> --wait` を走らせ、走っている間は待ち、終わったら `passed` で 0 を返す
4. `--timeout 5` で、待ち切れずに `pending` の 2 で終わる
5. 存在しない PR 番号で、エラーを出して 1 で終わる
6. 締めの段の手順書（`implement.md` の 2.2）を読み、CI の確かめ・直す上限・止まり方・表の形が書かれている（このカード自身の締めの段で、表の形の `## 動作確認の結果` を書いて確かめる）

## タスク

### 1. チェックのまとめと判定

- [x] `src/board/services/pr-checks.ts` に、`check-runs` と `status` の生の値から行（名前・出どころ・結果・URL）と全体の判定（`passed` / `failed` / `pending` / `none`）を作る純関数を書く
- [x] `src/board/services/__tests__/pr-checks.test.ts` に、設計の表の対応・両方が混ざる場合・チェックが無い場合のテストを書く

### 2. `ai-board pr checks`

- [x] `src/board/services/github-client.ts` の `GhPullRequestClient` に、PR の `head.sha` から `check-runs`（全件）と `status` を引く口を足す
- [x] `src/board/cli/pr-cli.ts` に `checks <n> [--wait] [--timeout <秒>] [--json]` を足す。判定ごとの終了コード、`--wait` の間隔と猶予と上限、使い方の行
- [x] `src/board/cli/__tests__/pr-cli.test.ts` に、出力・終了コード・`--wait` で待って終わる場合と待ち切れない場合のテストを書く（時刻と待ちは差し替えられるようにする）

### 3. 手順書

- [x] `.claude/skills/board-loop/implement.md` の 2.2 を「動かす → `pr checks --wait`（赤なら直す、2 回まで）→ 表の証拠 → archive → Ready」にし、止まるときの伝え方を足す。2.1 に fix の確かめ（先に落ちることを確かめ、コミットの本文に残す）を足す
- [x] `.claude/skills/board-loop/implement.md` のハードルールと `rules.md` の「締めの段はコードに触らない」を、CI を通すための直しだけ許す形に直す
- [x] `.claude/skills/board-loop/plan.md` の動作確認の手順の書き方に、表の行（確かめたこと・コマンド・期待する結果）にできる形で書くことを足す

### 4. ドキュメントと ADR

- [x] `README.md` の PR中 で読む証拠と締めの段の説明、`ai-board pr` の一覧に `checks` を足す
- [x] `docs/architecture.md` に `pr checks` の取得と判定を書く
- [x] `docs/adr/0005-verify-in-pr.md` の決定と結果に、Ready の前に CI を確かめること・証拠を表にすることを足す（`adr` のスキル）

## AI レビュー

- [ ] `src/board/services/github-client.ts:466` の `checks()` は、見るコミットを毎回 `pulls/{n}` の `head.sha` から取る。push の直後は GitHub がまだ PR の head を動かしておらず、前のコミットの済んだ結果（`passed`）で `--wait` が即座に 0 を返し、新しいコミットの CI を見ないまま Ready になりうる（締めの段は `fix:` の push の直後に `--wait` を走らせる）。`pr checks` に `--sha <sha>` を足し、指定されたらそのコミットの `check-runs` / `status` を引く（PR の `head.sha` と違う間は `pending` として待ち、猶予の 120 秒もそのコミットを見始めた時から数える）。`implement.md` の 2.2 の 2 は `--sha "$(git -C "$WT" rev-parse HEAD)"` を付けて呼ぶ形にし、`pr-cli.test.ts` に head が古い間は待つテストを足す
- [ ] `src/board/cli/pr-cli.ts:361` の `runChecks()` は、PR やチェックを読めなかったとき（gh の失敗、HTTP 502、`check-runs` の 403 など）も `fail()` で終了コード 1 を返し、`failed` の 1 と見分けがつかない。`implement.md` の 2.2 の 2 は 1 を「CI が落ちた、直す」と読むので、落ちたチェックが無いまま直しの手に入り、2 回の直しを使い切りうる。読めなかったときは別の終了コード（例: 3）にし、`pr-cli.ts` の使い方の行・`CHECKS_EXIT` の docstring・`docs/architecture.md`・`implement.md`（3 なら直さずに `止まった`）に書く。`pr-cli.test.ts` の「PR が読めなければ理由を出して 1 で終わる」をその終了コードに直す
- [ ] `src/board/services/github-client.ts:476` は `commits/{sha}/status` を `per_page` も `--paginate` も付けずに引くので、`statuses` は既定の 1 ページ目（30 件）だけになり、31 件目以降の落ちたコンテキストを見落として `passed` を返す（REVIEW.md の Important「1 ページ目だけを見て最新を決めるもの」）。`check-runs` と同じく `?per_page=100` と `--paginate --jq '.statuses[]'` で全件を 1 件 1 行で引き、403 / 404 を `statusUnreadable` にする扱いは保つ。`github-client` のテスト（無ければ `pr-cli.test.ts` の runner の差し替え）で、引数に `--paginate` が入ることを確かめる
- [ ] `.claude/skills/board-loop/implement.md:183` の「直すのは 2 回まで」は 1 つの手の中でしか数えていない。`止まった` は次の周から `next` を外れない（`SKILL.md` で外れるのは `保留して止まった` だけ）ので、間隔運転の周ごとに締めの段がやり直され、AI レビューを経ない `fix:` のコミットが周ごとに 2 つずつ積み上がる（計画の Decisions「2 回直しても通らなければ止まる」と食い違う）。CI の直しのコミットの本文に `CI を通すための直し` の行を書くと決め、直す前に `git -C "$WT" log origin/main..HEAD` でその行を数え、既に 2 つあれば直さずに `止まった` で終えると 2.2 の 2 とハードルールに書く

### 見送った指摘

- `src/board/cli/pr-cli.ts:365` の猶予の 120 秒は `--wait` を始めた時から数えるので、待っている間にほかの誰かが push すると、新しいコミットのチェックが登録される前に `none` の 0 で終わりうる。ループの中で push するのはループ自身で、`--wait` の間には push しない。`--sha` を足す直す指摘で、見るコミットを決めてから猶予を数える形になるので、別には直さない
- `.claude/skills/board-loop/implement.md:186` の締めの段の CI の直しには、2.1 の「直す前に落ちることを確かめる」がかからない。計画の Decisions で fix の確かめの対象を AI レビューの直す指摘と計画で fix と書いたタスクに決めており、CI の直しはその外にある。CI の直しは表の行と `fix:` のコミットに残り、人が PR中 で差分を読む
- `docs/architecture.md:335` の `ai-board pr checks` の節が、GitHub の取得と DB のマイグレーションの経緯の間に置かれ、前に空行が 2 つある。振る舞いに関わらない置き場所と整形の話なので見送る

### 人に判断してほしいこと

- `src/board/services/pr-checks.ts:81` と `src/board/services/github-client.ts:587`: Commit Status API が 403 / 404 で読めず、`check-runs` も 0 件のとき、判定は `none` で終了コード 0 になり、締めの段は Ready に進む。外部の CI だけを持つリポジトリをクラウドで扱うと、赤い外部の CI を見ないまま Ready になる。計画の Decisions「チェックが 1 つも無いリポジトリでは Ready にしてよい」は CI を持たないリポジトリを想定しており、「読めなかった」の場合は決めていない。この組み合わせを `pending` / 別の終了コードとして止めるか（クラウドで CI の無いリポジトリでも止まる）、今のまま表に `走らせていない` と書いて Ready にするかは人が決める
