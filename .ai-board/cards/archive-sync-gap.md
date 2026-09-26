---
id: archive-sync-gap
title: マージ済みと archive 済みを見分けられるようにする
created: '2026-09-11T01:52:44.055Z'
startedAt: null
skipGates: []
branch: null
mr: null
---

## アイデア

ボードは archive 済みかどうかを区別できない。`merged` の条件が
「archive に存在する **または** MR が merged」の OR になっているため、
両方が同じ列に落ちる。

```
| 1 | merged | archive に存在、または MR が merged |
```

結果、**「マージは済んだが delta spec が `openspec/specs/` へ同期されていない」
カードが完了列に紛れて見分けが付かない。**

`openspec/specs/` はこれから書く全部の change が差分の土台にするファイルなので、
同期漏れが静かに積み上がると後から効いてくる。実際 `board-lanes` は MR !4 の
マージで `merged` に入ったが、その時点で archive はされておらず
`openspec/specs/` は `.gitkeep` だけだった。

## 検討する方向

- `merged` を 2 段に割る（`merged` → `archived`）。10 列目が増える
- 列は増やさず、MR は merged だが archive されていないカードにバッジを出す
- archive を AI の自走工程として扱い、マージ後に自動で走らせる

列を増やすかどうかは、archive が「人が判断すること」か「AI が淡々とやること」かで決まる。
delta spec の本体へのマージは内容の判断を含むので、レビューを挟む余地はある。
一方で tasks が全完了して MR もマージ済みなら、残っているのは機械的な移動だけとも言える。

## 追記: 遅れて sync すると後続の change を巻き戻す

同期漏れは「積み上がる」だけでなく、**あとから解消しようとした瞬間に巻き戻しを起こす。**
`drop-explore-lanes`（MR !7 / !8）で実際に踏んだ。

経緯はこうだった。`board-lanes` が未 archive で `openspec/specs/` が空だったため、
後続の change が `MODIFIED` / `REMOVED` delta を書いても突き合わせる相手がいない。
そこで先に `board-lanes` の delta をメイン spec へ起こし、その上に
`drop-explore-lanes` の delta を重ねてマージした。

このあと `board-lanes` を archive しようとすると、archive 手順のステップ 4 が
もう一度 sync をかけようとする。`board-lanes` の delta は全て `ADDED` で、
sync の規則は「`ADDED` の要件が既にあれば内容を delta に合わせて更新する」である。
つまり `9 段のステージ` や `探索レビューは探索メモの存在で立つ` など 7 要件が復活し、
直前にマージした `drop-explore-lanes` が静かに巻き戻る。

今回は sync を飛ばして archive した。それが正しい判断だったのは、
その delta が既にメイン spec へ入っていることを人が知っていたからにすぎない。
判断の材料はボードにもファイルにも出ていない。

ここから言えることが 2 つある。

- **archive の遅れは順序の問題を生む。** 未 archive の change が 1 つでもあると、
  後続の change はその delta を踏み台にするか、踏まずに書くかを選ぶことになる。
  どちらを選んだかは記録に残らない。
- **`ADDED` を暗黙の `MODIFIED` として扱う規則は、時間が経った delta では危険。**
  sync が「適用済みかどうか」を持たないため、2 回目の適用が上書きになる。

バッジや列を足すより前に、**「この change の delta は既にメイン spec へ入っているか」
を導出できるか**を先に決めたい。入っていると分かるなら sync を飛ばす判断は機械にできる。

## 前提

- archive は git の操作ではなく `openspec/specs/` を書き換える操作。差分が生まれる
- `openspec-archive-change` スキルのステップ 4（`openspec-sync-specs`）が本体で、
  ステップ 5 のディレクトリ移動はその後始末
- 既知の未追従（CLAUDE.md）: change 名が `YYYY-MM-DD-` で始まる場合、
  openspec 1.12.0 は接頭辞を重ねないため、日付を剥がす前提の完了判定が外れる

## レビュー

### 2026-09-25T00:00:00.000Z plan 中止

前提が無くなった。このカードが問題にしていたのは openspec の archive が
`openspec/specs/` を書き換える操作であること、そして未 archive の change の delta を
後続が踏むと遅れて sync した瞬間に巻き戻る、という構造だった。OpenSpec を剥がし、
計画を `.ai-board/plans/<id>.md` 1 本に寄せたことで、archive は
`archive/` へファイルを移すだけの操作になり、メイン spec も delta も同期も無い。
「マージ済みと archive 済みを見分けられない」という元の困りごとも、
archive が merged を立てる唯一の実態になったため成立しない。
