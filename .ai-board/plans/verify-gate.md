# PR を見る前に、AI の実装を動かして確かめる列を足す

## 提案

### Why

今のゲートは 計画レビュー と PR中 の 2 つで、PR中 で人が見るのはコードの差分である。
振る舞いが意図どおりかを確かめるには、人がブランチを手元で動かすしかないが、ボードはそれを「人の番」として示さない。
差分を読んでから動かして食い違いに気づくと、レビューの手間が二重になる。

実装中 と PR中 の間に「動作確認」の列を入れ、役割を分ける。
動作確認では振る舞いが意図どおりかを見て、PR中 ではコードの質・設計・差分を見る。
動かして確かめた後に差分を読めば、PR のレビューはコードの話に集中できる。

### What Changes

- レビューゲートに `verify` を足す（`REVIEW_GATES = ['plan', 'verify']`）
- ステージに `verifying`（動作確認）を足し、`impling` と `pr` の間に置く。7 段になる
- `stage-resolver.ts` の `RULES` に 1 本だけ足す: plan 承認済みかつ verify が提出済みなら `verifying`。
  否決・承認・スキップに専用のルールは足さない
- AI は実装を終えて AI レビューを済ませたら、PR を Draft のまま `verify 提出` を書く。
  提出の本文には、人が動かすための手順（起動のコマンド、見る画面、期待する結果）と、AI が動かした結果を書く
- 人は動かして確かめ、判断待ちの区画のボタンで承認 / 否決する。
  承認なら AI が計画を archive へ移して `gh pr ready` で Ready にし、否決なら理由を読んで直し、再提出する
- 人が `skipGates` に `verify` を宣言したカードは、動作確認の列を通らずに今と同じく Ready へ進む
- `ai-board card submit` に `--gate <plan|verify>` を足す（既定は `plan`）
- `pickNextAction` に `revise-impl`（動作確認で否決された実装を直して再提出する）と `ready`（承認された実装を Ready にする）の 2 つの手を足す
- 計画に `## 動作確認の手順` の節を置く。計画レビューの時点で、人が何を見ることになるかを読める
- 詳細パネルに「動作確認を飛ばす」のトグルを足す（`PATCH /api/cards/:id` の `skipGates`）

### Impact

- 型: `src/cards/models/review.ts`、`src/shared/schemas/common.ts`、`src/shared/stage-labels.ts`、`src/web/types.ts`
- 導出: `src/board/services/stage-resolver.ts`、`src/board/services/next-action.ts`、`src/board/usecases/queries/get-board.query.ts`、`src/board/models/board-card.ts`
- 見せ方: `src/shared/dashboard-sections.ts`、`src/web/components/`（`InboxSection` / `ReviewActions` / `CardDetail` / `parts` / `PipelineStrip` と詳細パネル）
- CLI: `src/cards/cli/card-cli.ts`
- ループ: `.claude/agents/board-worker.md`、`.claude/skills/board-loop/SKILL.md`
- ドキュメント: `CLAUDE.md`、`README.md`、`docs/specs/board-stages/spec.md`、`docs/specs/card-review/spec.md`
- DB: `skip_gates` は JSON の文字列で CHECK 制約が無いので、マイグレーションは要らない
- API: `GET /api/board` の `stage` に `verifying` が、`gates` に `verify` のキーが増える。`POST /api/cards/:id/reviews` が `gate: "verify"` を受け付ける。
  `latestReview` に `gate` が増える。ローカル専用ツールで外部の利用者は無い

## 設計

### Decisions

#### ルールは `pr` と `impling` の間に 1 本だけ置く

```
1 merged      計画が archive 済み、または PR が merged
2 pr          PR が opened かつ Draft でない
3 verifying   plan 承認済み かつ verify が submitted      ← 足す
4 impling     plan 承認済み
5 plan-review 計画ファイルか Draft の PR があり plan が none / submitted
6 planning    startedAt が非 null
7 idea        既定
```

Draft の PR があっても計画レビューへ巻き戻らない。`plan-review` のルールは plan ゲートが none / submitted のときしか成立せず、
plan 承認後のカードは、Draft の PR を持っていても `plan-review` まで評価が降りてこないからである。

verify の状態ごとの行き先は、すべて既存の仕組みで決まる。

| verify の状態                       | ステージ  | 次に動く者                       |
| ----------------------------------- | --------- | -------------------------------- |
| none（まだ提出していない）          | impling   | AI（タスクを倒し、終われば提出） |
| submitted                           | verifying | 人（動かして承認 / 否決）        |
| rejected                            | impling   | AI（理由を読んで直し、再提出）   |
| approved（明示の承認）              | impling   | AI（archive して Ready にする）  |
| approved（`skipGates` に `verify`） | impling   | AI（今と同じく、終われば Ready） |
| どれでも、PR が Ready               | pr        | 人                               |

否決の差し戻しは、`plan` と同じくレビュー行（`verifying`）が外れて 1 つ手前の AI 列（`impling`）へ自然に落ちる。

既存のカードは巻き戻らない。Ready の PR はルール `pr` が先に勝ち、`verify` のエントリが無い実装中のカードは `impling` のまま。

#### `pickNextAction` に `revise-impl` と `ready` を足す

`impling` のカードは今は一律 `implement` になる。計画ファイルはブランチ側にあり、ボードを動かすチェックアウトからは
タスクの進み具合が見えないことが多いので、手の区別は verify ゲートの状態で付ける。

| verify の状態                      | 手            | 作業者がすること                                                                        |
| ---------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| none / `skipGates` による approved | `implement`   | タスクを 1 つ倒す。倒し終えていれば AI レビューをして、verify を提出（skip なら Ready） |
| rejected                           | `revise-impl` | 否決の理由と PR のコメントを読み、直してゲートを通し、`--resubmit` で再提出する         |
| 明示の承認                         | `ready`       | 計画を archive へ移してコミットし、`gh pr ready` で Ready にする                        |

`gateState` は skip と明示の承認をどちらも `approved` で返すので、`NextActionCard` に `skipGates` を足して区別する（`BoardCard` は既に持っている）。

`revise-impl` は `revise-plan` と対にし、直して再提出するまでを 1 手にする。
`implement` に畳むと「この否決への手直しを済ませたか」を作業者が見分ける印が要り、
否決が残っている間ずっと同じ手直しを繰り返しかねない。再提出すれば `verifying` へ上がるので、手が二重に選ばれることも無い。
直しが 1 手に収まらないほど大きければ、作業者は止まって報告する（人が計画ごと見直す方がよい）。

#### `latestReview` は「その列が待っているゲート」の最新エントリにする

画面の判断待ちの区画は、提出に書かれた本文と待ち始めた時刻を `latestReview` から出している（今は `plan` 固定）。
ゲートごとに持つと、受け手がどれを読むかをステージごとに分岐し直すことになる。
そこで、`latestReview` を 1 つのまま、待ちの列（`plan-review` → plan、`verifying` → verify）ではそのゲートの最新、
それ以外の列ではゲートを通じた最新のエントリにし、`gate` を足して何のエントリかを示す。
`waitingSince` はこれに従うだけで、`verifying` でも提出の時刻を待ち始めとして扱える。

ステージからゲートを引く表（今は web の `GATE_OF_STAGE`）は、サーバと web の両方が要るので `src/shared/` へ移す。

#### 手順は計画に書き、提出にも載せる

計画に `## 動作確認の手順` を置き、起動のコマンド・見る画面・期待する結果を書く。計画レビューの時点で、人が後で何を見ることになるかを読める。

`verify 提出` の本文には、実装を経て更新した手順と、AI が実際に動かした結果（動かせた範囲。画面を見られないときはそう書く）、計画からの差分を書く。
判断待ちの区画は提出の本文を畳まずに出すので、人は PR を開かずに手順を読める。

#### AI レビューは提出の前に済ませる

人が動かすのは AI レビューの指摘を直した後のコードにする。動かした後で AI レビューの修正が入ると、確かめた振る舞いが変わりうるためである。
`ready` の手では archive と Ready だけを行い、コードに触らない。

#### 飛ばすためのトグルを詳細パネルに足す

`skipGates` を書く入口は今 `PATCH /api/cards/:id` しかなく、画面にも CLI にも無い。
「小さな変更は飛ばせる」を使える形にするため、詳細パネルに「動作確認を飛ばす」のチェックボックスを足し、`skipGates` の `verify` を出し入れする。
CLI には足さない（エージェントが `skipGates` を書く入口を作らない、という書き込み境界を保つ）。
`plan` ゲートの飛ばしは今回の範囲に入れない。

### Risks / Trade-offs

- **`verifying` の名前の再利用。** cecbf0b で廃止した旧「検証中」（AI レビューの列）と同じ名前で、意味が違う。
  ステージは保存されないので古い値と衝突はしない。旧名の言及が残るのは archive の計画だけである
- **人の手間が 1 つ増える。** すべてのカードで動作確認を待つと、小さな変更でも人を 1 回待つ。`skipGates` のトグルで外せるようにする
- **AI が「動かした結果」を書けないことがある。** 画面の確認はエージェントには難しい。書けない範囲は書けないと明記させ、推測で「確認した」と書かせない
- **このカード自身は旧手順で進む。** 作業者の定義はメインのチェックアウトから読まれるので、このカードの実装はマージまで今の `implement`（倒し終えたら Ready）で進む。
  新しい流れを通しで確かめるのはマージ後になる
- **別案: 列にせず、Ready の前に verify 承認を要るだけにする。** 列にしないと、動かして確かめる番が判断待ちの区画に出ず、ボードが人の番を示さないという元の問題が残る

### Non-Goals

- ボードの UI からブランチのコードを起動すること（書き込み境界と信頼の議論が別に要る。別カード）
- `plan` ゲートを飛ばすトグル
- 承認や否決の入口を CLI に足すこと
- 承認の理由に書かれた別件を自動で起票する仕組み（作業者が `ai-board card create` で起票すれば足りる）

## 動作確認の手順

1. `npm run build` の後、`node dist/cli.js status` で、`verify 提出` のあるカードが判断待ちに `[動作確認]` として出ること
2. `npm run dev` と `npm run dev:web` を起動し、ブラウザで次を見る
   - 件数帯に「動作確認 ★」の列があり、`impling` と `pr` の間に並ぶ
   - 判断待ちの区画に動作確認のカードが出て、提出の本文（手順）が見え、「PR を開く」のリンクと承認 / 否決 / 中止のボタンが使える
   - 否決すると AI 作業中の区画（実装中）へ戻り、承認しても実装中に残る（AI が Ready にするのを待つ）
   - 詳細パネルの「動作確認を飛ばす」を入れると、提出済みのカードが実装中に落ちる
3. 確かめには、ダミーのカードを `ai-board card create` で作り、`AI_BOARD_DB` で別の DB を指して試す（共有の DB を汚さない）

## タスク

### 1. ゲートとステージ

- [ ] `verify` ゲートと `verifying` ステージを足し、導出のルールを 1 本足す。型を壊す変更と受け止める箇所を 1 つのコミットにまとめる
  - `REVIEW_GATES` を `['plan', 'verify']` に、`STAGES` の `impling` と `pr` の間に `verifying` を入れる
  - `Record<Stage, …>` / `Record<ReviewGate, …>` の表を埋める: `STAGE_LABELS`（動作確認）、`SECTION_OF_STAGE`（inbox）、web の `Stage` / `ReviewGate` / `STAGE_OWNER`（human）/ `STAGE_SOURCE`（plan）
  - `stage-resolver.ts` の `toFacts` に `verify` を、`RULES` に `verifying` のルールを足し、docstring の判定表を 7 段に直す
  - テスト: plan 承認・verify 提出・Draft の PR あり → verifying / verify 否決 → impling / verify 承認 → impling / `skipGates` に verify → impling / verify 提出済みでも PR が Ready → pr / plan 未承認で verify のエントリだけある → 計画側の列のまま

### 2. 判断待ちの見せ方（サーバ側）

- [ ] `GATE_OF_STAGE` を `src/shared/` へ移し、`latestReview` を「その列が待っているゲート、無ければゲートを通じた最新」のエントリにして `gate` を足す
- [ ] `awaitsPlanDecision` を `awaitsDecision` に改め、`verifying` も判断待ちにする。`waitingSince` の docstring に動作確認を足す。`dashboard-sections.test.ts` に `verifying` の振り分け・待ち時間・判断の要否を足す

### 3. 次の一手

- [ ] `pickNextAction` に `revise-impl` と `ready` を足す。`NextActionCard` に `skipGates` を足し、明示の承認と skip を区別する
  - テスト: verify none → implement / rejected → revise-impl / 明示の承認 → ready / skip → implement / verifying のカードは選ばない
- [ ] `status-cli.test.ts` に、`verifying` のカードが `waiting` に入り `next` に選ばれないことを足す

### 4. CLI

- [ ] `ai-board card submit` に `--gate <plan|verify>` を足す（既定は `plan`、不正な値は使い方を出して失敗）。使い方の文言とテストを直す

### 5. API

- [ ] `board.e2e.test.ts` に、`POST /api/cards/:id/reviews` が `gate: "verify"` を受け付け、`GET /api/board` で `verifying` と `latestReview.gate` が返ることを足す

### 6. 画面

- [ ] 判断待ちの区画で、`verifying` のカードを計画レビューと同じ形で出す。リンクは「PR #n を開く」、提出の本文の札は `<gate> <種別>`
- [ ] `StagePill` の ★、件数帯の `GATE_STAGES`、`ReviewActions` の否決理由の placeholder、`CardDetail` のボタンの出し分けを `verifying` に対応させる。「6 段」の docstring を直す
- [ ] 詳細パネルに「動作確認を飛ばす」のチェックボックスを足す（`skipGates` の `verify` を出し入れし、他のゲートの値は保つ）

### 7. ループ

- [ ] `.claude/agents/board-worker.md` を直す
  - `plan`: 計画の構成に `## 動作確認の手順` を足す
  - `implement`: 倒し終えたら AI レビューの後、`skipGates` に `verify` があれば今と同じく archive して Ready に、無ければ PR を Draft のまま `ai-board card submit <id> --gate verify --reason "<手順と動かした結果>"` で止まる
  - `revise-impl` と `ready` の節を足す。報告の「AI レビュー」の項目を、提出か Ready にした手で書くように直す
- [ ] `.claude/skills/board-loop/SKILL.md` の説明と手の一覧に `revise-impl` / `ready` と動作確認の待ちを足す

### 8. ドキュメント

- [ ] `CLAUDE.md`: 冒頭の列図、列の所有権の表、ステージ導出、`card submit` の使い方、1 周の流れ、やってはいけないこと（verify の承認 / 否決も人が書く）を直す
- [ ] `README.md` の列の表と AI ループの節、`docs/specs/board-stages/spec.md` と `docs/specs/card-review/spec.md` を直す

### 9. 確かめる

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` と `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DB` の別の DB で試す
- [ ] Ready にする直前に、計画を `plans/archive/` へ移す（このカードは旧手順で進む）
