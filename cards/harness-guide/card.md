---
id: harness-guide
title: ユーザは、ハーネスのどの部品が HIL・文脈の切り分け・品質ゲートを担っているかを、1 枚の案内から辿りたい
created: '2026-10-31T06:52:01.173Z'
skipGates: []
branch: null
mr: null
---

## アイデア

研修の受講者向けに、このリポジトリのハーネスの読み方の案内を 1 枚書く（例: `docs/harness-guide.md`）。

- **観点ごとに部品をたどる。**
  - 人の判断ゲート（HIL）: ステージの導出、`ai-board card` の CLI の境界、人の API、`board-decide`
  - 文脈の切り分け: 監視役（board-loop）と作業者（board-worker / board-task / board-reviewer）、書いた者が審査しない分業
  - 品質ゲート: typecheck / lint / format / test、CI、カバレッジの閾値、`REVIEW.md`
- **なぜそうしたかを示す。** 各部品について、`.ai-board/plans/archive/` のどの計画で入ったかと、どんな失敗がきっかけだったかをつなぐ
- **自分の題材で回すときの読み順も書く。** CLAUDE.md の読み方、ボードのどこを見るか

## 背景

研修では、受講者がこのリポジトリを fork してループを回す。
回すだけでは、どの部品が何を守っているのかが見えにくい。CLAUDE.md は AI 向けに書かれていて、人が最初に読む案内にはなっていない。
伝えたいのは HIL・文脈の切り分け・品質ゲートの 3 つなので、その観点から部品へたどれる入口がほしい。
