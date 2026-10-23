# 画面と説明に残る GitLab 時代の書き方を、GitHub の PR に揃える

## 提案

### Why

GitLab 連携は廃止し、取得先は GitHub の PR だけになった。それでもステージの理由には GitLab の書き方が残っており、
`MR !28 がオープン` / `MR !28 がマージ済み` と出る。同じ画面には `計画の PR #28（Draft）が人の承認を待っている` とも出るので、
1 つの PR が 2 通りの書き方で並んでいる。`ai-board status` の出力でも `MR !30 がオープン` と出て、PR #30 のことだと読み替える必要があった。

あわせて、作りが変わったのに直っていない説明（コメント）がある。カードの保存先を Markdown ファイルと書いたもの（今は SQLite）と、
廃止した列ドラッグを前提にしたもの（今は「着手」「着手を戻す」のボタン）である。

### What Changes

- ステージの理由（`stage-resolver.ts`）の `MR !n` を `PR #n` にする
- カードの詳細の入力欄のラベル `MR iid` を `PR 番号` にする（`LinkFields.tsx`）
- 古い説明を直す: `card.repository.ts` の「Markdown ファイル」、`stage-resolver.ts` / `board-card.ts` / `web/types.ts` の「ドラッグで動かせる」「ドラッグ不可」
- CLAUDE.md の書き込み境界の表の「MR 番号の書き戻し」を「PR 番号の書き戻し」にする

### Impact

- 変更: `src/board/services/stage-resolver.ts`、`src/web/components/detail/LinkFields.tsx`、上のコメントのファイル、`CLAUDE.md`、テスト
- 型・変数・関数の名前、DB の列、API の項目名は変えない（下の Decisions）
- GitLab の MR と GitHub の PR を取り違えた経緯を書いた README / CLAUDE.md の段落は、歴史の説明なのでそのまま残す

## 設計

### Decisions

#### 人が読む文字だけを変え、識別子は変えない

`MrState` / `MergeRequestIid` / `iid` / `fetchByIid` / `MrStateProvider` などの識別子は、テスト以外で 22 ファイル、テストで 8 ファイルにある。
一方、外から見える名前（DB の `mr` 列、カードの frontmatter の `mr`、`GET /api/board` の `mr` / `mrState`）は、
変えるとマイグレーションと画面の同時の変更が要り、ワークツリー間で共有する DB の後方互換にも関わる。
外の名前を残したままコードの中だけを PR に改めると、境界で名前が食い違い、かえって読みにくくなる。

このカードでは、利用者と人が読む文字（画面の文言、コメント、ドキュメント）だけを揃える。
識別子と外の名前の改名は、必要になったら別のカードで、外の名前とまとめて扱う。

#### 理由の文言をテストで固める

今のテストは理由の文言を見ていないので、`MR !n` が残っていても気付けなかった。
`stage-resolver.test.ts` に、PR中 / マージ済み / 再レビュー待ちの理由が `PR #n` を含むことを確かめるテストを足す。

### Risks / Trade-offs

- **識別子に MR が残る。** コードを読む人は、引き続き `mr` を PR と読み替える必要がある。外の名前と揃っていることを優先した
- **理由の文言を見ている利用者がいれば変わる。** `ai-board status --json` の `reason` を文字列で照合している使い手があれば影響する。
  ループのスキルは `reason` ではなく `next.action` と `stage` を見ているので影響しない

### Non-Goals

- 型・変数・関数の名前の改名
- DB の `mr` 列、カードの frontmatter、API の `mr` / `mrState` の改名
- 取得先を「レビュー要求」と抽象化した CLAUDE.md の書き方の見直し

## タスク

- [x] `stage-resolver.ts` の理由の `MR !n` を `PR #n` にし、`stage-resolver.test.ts` に理由の文言のテストを足す
- [ ] `LinkFields.tsx` のラベル `MR iid` を `PR 番号` にする
- [ ] 古い説明を直す（`card.repository.ts` の Markdown ファイル、`stage-resolver.ts` / `board-card.ts` / `web/types.ts` のドラッグ）
- [ ] CLAUDE.md の書き込み境界の表の「MR 番号の書き戻し」を「PR 番号の書き戻し」にする
