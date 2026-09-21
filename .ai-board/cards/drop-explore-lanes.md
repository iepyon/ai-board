---
id: drop-explore-lanes
title: 探索中と探索レビューのレーンを削る
created: '2026-09-11T04:20:00.000Z'
startedAt: null
skipGates: []
change: drop-explore-lanes
branch: drop-explore-lanes
mr: 7
forge: gitlab
---

## アイデア

9 列のうち `exploring`（探索中）と `explore-review`（探索レビュー）が、実運用で列として
機能していなかった。探索は計画提案と一体で進み、explore ゲートの承認は `planning` へ
進むためだけの通過儀礼になっていた。人が見るべき判断点は計画レビューと PR の 2 つで足りる。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ 検証中 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI       AI      人 ★        —
```

- ステージを 9 段から 7 段へ。`exploring` と `explore-review` を削除
- `startedAt` の打刻が立てるステージを `exploring` から `planning` へ。
  人がドラッグする 1 遷移は `アイデア ⇄ 計画提案中` になる
- レビューゲートは `plan` の 1 つだけに。`## 探索メモ` はステージ導出の入力から外れる
  （本文の自由記述としては残る）

`RULES` から 2 本を落とし、`planning` の条件を差し替えただけで済んだ。
差し戻しのための `if` は増えていない。`resolveFloorStage` / `droppableStages` は
`HUMAN_STAGES` の差し替えのみで構造は不変。

既存カードに残る `explore` のレビュー記録は、規定外のゲートとして `parseReviewLog` が
黙って無視する。データ移行は行わなかった。`skipGates` だけは Zod で検証されるため
`explore` を含むカードは読み込みエラーになるが、該当するカードは 1 枚も無い。

## 残したもの

このカードは作業が終わってから起票した。そのため `startedAt` は打っていない。
ステージは archive 済みであることから `merged` に落ちる。

派生した気づきは `archive-sync-gap` カードへ追記した。未 archive の change の delta を
後続の change が踏むと、あとから sync した瞬間に巻き戻しが起きる、という話である。
