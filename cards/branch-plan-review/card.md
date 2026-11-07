---
id: branch-plan-review
title: ユーザは、GitHub に届かなくても、AI が計画を提出したら計画レビューの判断待ちに出してほしい
created: '2026-11-06T09:36:57.022Z'
skipGates: []
branch: ccr-bb1fbf36-7v5cd6
mr: 97
---

## アイデア

メインのチェックアウトに計画ファイルが無く、Draft の PR も引けないとき、カードのブランチにある計画ファイルを手元で読み、計画レビューの列を立てる。

- **手元のブランチを読む。** `src/board/repositories/branch-plan.repository.ts` は `git fetch` をせず、手元のブランチ（無ければ `origin` の追跡ブランチ）から計画を読む。今は次の一手の段を決めるのにしか使っていないものを、ステージの導出に渡す計画の出どころにも使う
- **導出の核は変えない。** `stage-resolver.ts` に条件は足さない。「計画ファイルが存在するだけで計画レビューの列が立つ」という今の決まりのまま、渡す計画の出どころを広げるだけにする

## 背景

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。
計画ファイルは PR のブランチにコミットされ、ボードを動かすメインのチェックアウトからは見えないので、今は Draft の PR を計画の成果物として扱っている。
GitHub に届かないと Draft の PR が引けないので、AI が計画を提出してもカードは 計画提案中 のままで、判断待ちに出ない。人は計画レビューの番が来たことに気付けない。
計画ファイルは手元のブランチにあるので、それを読めば GitHub に届かなくても計画レビューを立てられる。

## 探索メモ

- 2026-11-06 の調べ。ステージの規則 4 は「計画ファイルか Draft の PR があり、plan ゲートが none / submitted」。計画ファイルはメインのチェックアウトの `.ai-board/plans/` から読む（`config.paths.plansDir`）
- 計画で決めること
  - 全カードのブランチを毎回 `git show` で読むと遅くならないか（`branch` を持つカードだけ、マージ済みは読まない、など）
  - ブランチの計画が archive に移されたとき（マージ済みの判定）とのかみ合わせ
  - オンラインのときも同じ読み方にするか（Draft の PR が出る前に計画レビューが立つことになる）
- PR中 の列はオフラインでは立たない（PR が無いため）。研修で要るかは別に決める
- 2026-11-07 の追加の調べ（コードを読んで確かめた）
  - **ブランチの archive は読まない。** ステージの規則 1（計画が archive 済み → マージ済み）は規則 2（PR中）より上にある。実装の締めはブランチで計画を archive してから Ready にするので、ブランチの `plans/archive/<id>.md` を読むと PR中 のカードがマージ前にマージ済みに見える。ブランチから渡すのは `plans/<id>.md` だけにする
  - **読むカードは絞れる。** 規則 4 に効くのは、着手済みで `branch` があり、plan が none / 提出で、メインのチェックアウトに計画が無いカードだけ。`GitBranchPlanRepository.find`（`src/board/repositories/branch-plan.repository.ts`）は 1 枚につき `check-ref-format`・`rev-parse`・`show` の数回の git を走らせる
  - `PlanRepository.load()`（`src/board/repositories/plan.repository.ts`）はカードの一覧を受けないので、ブランチの計画を重ねるのは `get-board.query.ts` か、カードを受ける別の口になる。`PlanDoc.updatedAt` はファイルの mtime なので、ブランチから読むときはコミットの時刻などで代える
  - **未設定のボードの計画の手は push と `ai-board pr create` で失敗し、提出まで届かない**（`.claude/skills/board-loop/plan.md` の 4）。ブランチの計画を読めても、手順書を直さないと研修では効かない
  - 「使えません」（`github:` を書いたまま届かない）のボードは #96（`forge-unset-decide`）のとおり判断を拒むので、計画レビューに出ても承認は書けない
  - 承認の後の実装の手も、節ごとの `git push` と締めの `ai-board pr checks` / `pr edit` / `pr ready` で、未設定のボードでは止まる
- 人の答え（2026-11-07、チャットで）
  - ブランチの計画で計画レビューを立てるのは、GitHub が未設定（`isForgeUnset`）のボードのときだけ。接続済みは今どおり Draft の PR で立て、使えません / エラーのボードは `offline-snapshot-view` に任せる
  - 未設定のボードで、ループの計画の手（`plan.md`）が push と Draft の PR を飛ばし、コミット → `card branch` → `card submit` だけをするように、このカードで直す
  - 承認の後の実装の手（節ごとの push、締めの `pr checks` / `pr edit` / `pr ready`）と、PR の無いボードでのマージ済みの判定は、別のカードにする
