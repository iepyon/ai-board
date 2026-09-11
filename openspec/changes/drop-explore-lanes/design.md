## Context

動機は proposal.md の Why にある。ここでは現状の制約だけを書く。

ステージ導出は `src/board/services/stage-resolver.ts` の `RULES` 配列 1 本で表現されている。
配列の順序が「上から評価して最初に真になったものが勝つ（＝最も進んだステージ）」を意味し、
制御構造は持たない。ステージの集合は `src/shared/schemas/common.ts` の `STAGES`、
ゲートの集合は `src/cards/models/review.ts` の `REVIEW_GATES` が単一の出所になっている。

web 側（`src/web/types.ts`）はサーバの型を手で写した独立の定義を持つ。
パスエイリアスを使わず、`src/shared/` だけが両 tsconfig から参照される構成のため、
ステージの列挙は 2 か所に存在する。片方だけ直すと typecheck が通ってしまう。

カードファイルは人が直接編集してよく、`review-log.ts` は書式の壊れた見出しを黙って無視する。
この寛容さが、廃止されたゲートの扱いをそのまま決める。

## Goals / Non-Goals

**Goals:**

- ステージとゲートの定義を減らしたぶんだけ、導出ルールも素直に短くなること
- 既存カードに残る `explore` のレビュー記録が、ボードを壊さずに無視されること

**Non-Goals:**

- 既存カードの本文からの `## 探索メモ` 見出しや `explore` エントリの一括削除
- 列内の並び順・中止カードの表示・MR 連携など、今回の削除と無関係な挙動の変更
- 探索工程そのものの廃止。`/opsx:explore` は引き続き使える

## Decisions

### `planning` を「explore 承認済み」から「`startedAt` が非 null」へ差し替える

`RULES` から `exploring` と `explore-review` の 2 本を落とし、残った `planning` の条件を
入れ替える。これで配列の末尾は `startedAt` を見るルールになり、その次が既定の `idea` になる。

代替案として、`exploring` を残したまま `explore-review` だけを削ることも考えた。
しかし `exploring` は「AI が探索している」列であり、探索の成果物を人が見ないなら
`planning` と区別する意味が無い。2 つまとめて落とすほうが列の意味が濁らない。

`resolveFloorStage` / `droppableStages` は構造を変えない。`HUMAN_STAGES` を
`['idea', 'planning']` に差し替えるだけで、`rank(列) >= rank(下限)` の判定はそのまま働く。
proposal が存在するカードの下限は `plan-review` になり、ドロップ先は空になる。

### 廃止した `explore` ゲートは「規定外のゲート」として黙って無視する

`REVIEW_GATES` から `explore` を外すと、`isReviewGate('explore')` が false を返し、
`parseReviewLog` は既存の「書式の壊れた見出しは無視する」経路でそのエントリを捨てる。
移行スクリプトもデータ変換も要らない。

代替案は、既存カードから `explore` の記録を一括削除することだった。採らない。
レビューログは人の判断の履歴であり、列の定義が変わったことを理由に過去の記録を
書き換えるのは、追記専用という原則に反する。記録は残し、解釈だけをやめる。

`skipGates` は事情が違う。こちらは Zod スキーマ（`ReviewGateSchema` の配列）で検証されるため、
`explore` を含むカードはパースに失敗して読み取りエラーになる。現時点でそのようなカードは
1 枚も無いことを確認済みなので、許容する。無視して通すために検証を緩めるほうが害が大きい。

### ステージの列挙はサーバと web の 2 か所を同時に直す

`src/shared/` に寄せて 1 か所にする案もあるが、web 側の型はラベル・所有者・帯色・
ゲート対応表といった UI 固有の対応表と一体で書かれており、共有化は今回の削除より大きい。
2 か所を直し、型で拾えない漏れはテストと目視で埋める。

`STAGE_LABELS` / `STAGE_OWNER` / `STAGE_SOURCE` は `Record<Stage, ...>` なので、
`Stage` から 2 つ消せば余ったキーを typecheck が検出する。
`GATE_OF_STAGE` は `Partial<Record<...>>` なので検出されない。手で直す。

## Risks / Trade-offs

- 探索の成果物を人が見る機会が `plan-review` の 1 回だけになる → 探索が的外れなまま
  proposal まで進むと、差し戻しの手戻りが大きくなる。`skipGates` の逆で、
  重いカードは人が `startedAt` を打つ前に口頭で握るという運用で受ける。
- `## 探索メモ` が導出の入力でなくなることで、見出しを書いてもボードが動かなくなる →
  README と CLAUDE.md の書き込み境界の記述を同時に直し、AI エージェント向けの
  ハードルール（`.ai-board/cards/board-loop-skill.md`）からも探索レビューの記述を落とす。
- web 側の `Stage` 定義の直し漏れ → `Record<Stage, ...>` の網羅性検査で大半は落ちる。
  落ちない `GATE_OF_STAGE` と `Board.tsx` の `switch` は目視で確認する。

## Migration Plan

デプロイ単位はローカルのプロセス 1 つで、永続データはカードファイルだけである。
カードファイルの書式は変えないので、前方・後方どちらの移行作業も無い。

ロールバックはリバートで足りる。`explore` のレビュー記録を消さないため、
戻したあとも探索レビューの列はそのまま復元される。
