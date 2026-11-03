---
id: merge-verify-into-pr
title: ユーザは、動作確認の列を無くし、PR で証拠を見て動かして差分を読む、を 1 回で済ませたい
created: '2026-11-03T14:35:05.182Z'
skipGates: []
branch: merge-verify-into-pr
mr: null
---

## アイデア

動作確認の列（`verifying`、verify ゲート）を無くし、人の確かめを PR中 の 1 回にまとめる。
人は PR を開いたときに、AI が付けた証拠（`verify-evidence`）を見て、必要なら手で動かし、差分を読む、をまとめて行う。

- **流れ。** 実装中 → PR中 → マージ済み。AI は実装と AI レビューを済ませ、証拠を PR に付けて Ready にする
- **差し戻し。** PR のレビューのコメントで行う。指摘に AI が応える道は `pr-feedback-ai-turn` で作る
- **消えるもの。** `verifying` のステージと導出の規則、verify ゲート、次の一手の `revise-impl` と `ready`、`skipGates` の `verify`、verify の保留、
  Draft と Ready の出し入れに伴う止まり（人の判断の後に人が Draft に戻した、など）、`board-worker` の締めの段と `revise-impl` / `ready` の手順、画面と `board-decide` の verify の判断

## 背景

2026-11-03 に、今の Claude のモデルを前提にハーネスを簡素にする案を話し合い、人がこのカードの起票を頼んだ。

今は 実装中 → 動作確認 → PR中 で、すべてのカードで人を 2 回待つ（ADR 0005）。小さな変更は「動作確認を飛ばす」で和らげているが、宣言の読み方（ADR 0009）と止まりの扱いが増えた。
ADR 0005 が防いだのは「差分を読んだ後に動かして意図との違いに気付き、直した後にもう一度差分を読む」二度手間である。
AI が動かした結果とテストの証拠を PR に付ければ（`verify-evidence`）、人は差分を読む前に振る舞いを確かめられ、この二度手間はかなり減る見込みがある。

## 論点

- **`verify-evidence` との順番。** 証拠が無いまま列を消すと、人は PR中 で手で全部動かすことになる。`verify-evidence` を先に入れるか、同じカードでやるか
- **振る舞いとコードの確かめの順番。** 1 つの列の中で「まず動かす、その後で差分を読む」を人の手順として残すか。PR の本文の証拠の節を先頭に置くなどの見せ方で足りるか
- **Draft と Ready。** AI が Ready にする時点を「AI レビューと証拠が揃ったとき」にする。計画レビューの Draft の PR（ADR 0004）はそのまま使う
- **否決の記録。** verify の否決は `## レビュー` に残るが、PR のレビューは GitHub に残る。差し戻しの回数をメトリクス（`harness-metrics`）でどう数えるか
- **既にあるカードの移り方。** 動作確認の列にいる・verify の判断が `## レビュー` に残っているカードを、導出がどう読むか（古い `verify` のエントリは無視するか）
- **研修。** 研修で伝える人の判断ゲート（HIL）が、計画レビューと PR中 の 2 つになる。「動作確認で人が動かして初めて分かるズレ」の題材（`training-seed`）をどう扱うか
- **ADR。** ADR 0005（verify ゲート）と 0009（飛ばす宣言）を書き直すか消す。0006（AI が書ける判断と止まり）も見直す

## 探索メモ

2026-11-03、PR #75（`loop-single-session`）がマージされ、`board-planner` / `board-worker` のエージェント定義は消えた。計画と実装の手は、本筋のセッションが `.claude/skills/board-loop/plan.md`・`implement.md` を読んで自分で進める。共通の決まり `subagent-rules.md` は `rules.md` に改名された。残るエージェント定義は `board-reviewer` だけである。
アイデアの「`board-worker` の締めの段と `revise-impl` / `ready` の手順」は、今は `.claude/skills/board-loop/implement.md` の 2.2・3・4 節である
