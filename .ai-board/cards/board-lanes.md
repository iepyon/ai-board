---
id: board-lanes
title: レーンを HIL ゲート付きの 9 列に作り直す
created: '2026-09-11T00:00:00.000Z'
explored: true
implStartedAt: null
change: null
branch: board-lanes
mr: null
stageOverride: null
---

## アイデア

現行の 7 列は「工程がどこまで進んだか」と「いま誰の番か」を 1 本の軸に畳んでいる。
`explored` は "探索が済んだ" と "人の承認待ち" を兼ね、`proposed` も `ai-pr` も同じ二重性を持つ。

人が関与すべき列（HIL）と AI が自走する列を、列そのもので分ける。

```
[ アイデア ] [ 探索中 ] [ 探索レビュー ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ 検証中 ] [ PR中 ] [ マージ済み ]
     人          AI          人 ★           AI             人 ★          AI        AI      人 ★        —
```

人がドラッグするのは `アイデア ⇄ 探索中` の 1 遷移だけ。★ の列は承認 / 否決 / 中止のボタンを持ち、
否決は理由文が必須。`skipGates` で事前にゲートを飛ばせる。

`stage` は保存せず常に純関数の出力とする原則は維持する。人の判断（着手・承認・否決）も
ファイル上の痕跡として残るので、それも実態として導出の入力にする。

設計は `docs/superpowers/specs/2026-09-11-board-lanes-design.md`、
実装計画は `docs/superpowers/plans/2026-09-11-board-lanes.md` にある（9 タスク）。

## 探索メモ

- 探索の成果物置き場はカード本文の `## 探索メモ`。`gitlab-mr-loop.md` が既にこの見出しを使っており、
  CLAUDE.md の書き込み境界も AI に本文を許している
- `explored` / `implStartedAt` / `stageOverride` は削除。`startedAt` / `skipGates` を追加する
- `ai-pr-fixed` は列から降りて `PR中` 内のバッジになる。`hasFixAfterReview` は用途変更で残る
- `検証中` は `TaskProgress`（`completed` / `total`）から導出できる。この既存フィールドは現在どのルールも使っていない
- 既存 16 枚は全て `explored: false` / `implStartedAt: null` なので実質的な移行は起きない
- 依存: 列内の並び順は `card-ordering`、検証失敗の表示は `loop-activity`、MR 作成手順は `gitlab-mr-loop` に委ねる
