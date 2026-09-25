# 探索中と探索レビューのレーンを削る

> openspec の change から移した計画。見出しは 1 段下げてある。

## 提案

### Why

9 列のうち `exploring`（探索中）と `explore-review`（探索レビュー）は、実運用で列として機能していない。
探索は計画提案と一体で進み、explore ゲートの承認は `planning` へ進むためだけの通過儀礼になっている。
人が見るべき判断点は計画レビューと PR の 2 つで足り、列とゲートを 1 組減らすことで
ボードの意味も導出ルールも小さくなる。

### What Changes

- **BREAKING** ステージを 9 段から 7 段へ減らす。`exploring` と `explore-review` を削除する。
  - `idea` → `planning` → `plan-review` → `impling` → `verifying` → `pr` → `merged`
- **BREAKING** `startedAt` の打刻が立てるステージを `exploring` から `planning` へ変える。
  人がドラッグできる 1 遷移は `アイデア ⇄ 計画提案中` になる。
- **BREAKING** explore ゲートを廃止する。レビューゲートは `plan` の 1 つだけになる。
  - `## 探索メモ` 見出しはステージ導出の入力ではなくなる（本文の自由記述としては残る）。
  - `skipGates` に `explore` を宣言できなくなる。
  - `POST /api/cards/:id/reviews` は `gate: "explore"` を受け付けなくなる。
- 既存カードに残る `### <時刻> explore <種別>` の行は、未知のゲートとして黙って無視される。
  データ移行は行わない。

### Capabilities

#### New Capabilities

なし。

#### Modified Capabilities

- `board-stages`: ステージの段数・`startedAt` が立てるステージ・ドラッグ可能な遷移が変わり、
  探索レビューの導出ルールが無くなる。
- `card-review`: ゲートの集合が `explore` / `plan` の 2 つから `plan` の 1 つへ減り、
  探索メモを成果物として扱う要件が無くなる。

### Impact

- `src/shared/schemas/common.ts` — `STAGES` から 2 段を削除
- `src/cards/models/review.ts` — `REVIEW_GATES` を `['plan']` へ
- `src/board/services/stage-resolver.ts` — `RULES` から 2 本を削除し、`planning` の条件を
  「explore 承認済み」から「`startedAt` が非 null」へ差し替える。`HUMAN_STAGES` を
  `['idea', 'planning']` へ
- `src/cards/services/review-log.ts` — `hasExploreNote` / 探索メモ見出しの定数を削除
- `src/web/types.ts` / `Board.tsx` / `detail/BodyEditor.tsx` — 列のラベル・所有者・色・
  ドロップ時のパッチ
- テスト: `stage-resolver.test.ts` / `board.e2e.test.ts`
- ドキュメント: `README.md` / `CLAUDE.md` の列の表
- `.ai-board/cards/board-loop-skill.md` のハードルール（探索レビューへの言及）
- API 互換: `GET /api/board` が返す `stage` / `floorStage` / `droppableStages` と
  `gates` のキー集合が変わる。ローカル専用ツールのため外部の利用者は無い。
- `openspec/specs/` はまだ空で、`board-stages` / `card-review` は `board-lanes` の
  delta spec としてのみ存在する。本 change の delta も同じ capability path に置く。

## 設計

### Context

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

### Goals / Non-Goals

**Goals:**

- ステージとゲートの定義を減らしたぶんだけ、導出ルールも素直に短くなること
- 既存カードに残る `explore` のレビュー記録が、ボードを壊さずに無視されること

**Non-Goals:**

- 既存カードの本文からの `## 探索メモ` 見出しや `explore` エントリの一括削除
- 列内の並び順・中止カードの表示・MR 連携など、今回の削除と無関係な挙動の変更
- 探索工程そのものの廃止。`/opsx:explore` は引き続き使える

### Decisions

#### `planning` を「explore 承認済み」から「`startedAt` が非 null」へ差し替える

`RULES` から `exploring` と `explore-review` の 2 本を落とし、残った `planning` の条件を
入れ替える。これで配列の末尾は `startedAt` を見るルールになり、その次が既定の `idea` になる。

代替案として、`exploring` を残したまま `explore-review` だけを削ることも考えた。
しかし `exploring` は「AI が探索している」列であり、探索の成果物を人が見ないなら
`planning` と区別する意味が無い。2 つまとめて落とすほうが列の意味が濁らない。

`resolveFloorStage` / `droppableStages` は構造を変えない。`HUMAN_STAGES` を
`['idea', 'planning']` に差し替えるだけで、`rank(列) >= rank(下限)` の判定はそのまま働く。
proposal が存在するカードの下限は `plan-review` になり、ドロップ先は空になる。

#### 廃止した `explore` ゲートは「規定外のゲート」として黙って無視する

`REVIEW_GATES` から `explore` を外すと、`isReviewGate('explore')` が false を返し、
`parseReviewLog` は既存の「書式の壊れた見出しは無視する」経路でそのエントリを捨てる。
移行スクリプトもデータ変換も要らない。

代替案は、既存カードから `explore` の記録を一括削除することだった。採らない。
レビューログは人の判断の履歴であり、列の定義が変わったことを理由に過去の記録を
書き換えるのは、追記専用という原則に反する。記録は残し、解釈だけをやめる。

`skipGates` は事情が違う。こちらは Zod スキーマ（`ReviewGateSchema` の配列）で検証されるため、
`explore` を含むカードはパースに失敗して読み取りエラーになる。現時点でそのようなカードは
1 枚も無いことを確認済みなので、許容する。無視して通すために検証を緩めるほうが害が大きい。

#### ステージの列挙はサーバと web の 2 か所を同時に直す

`src/shared/` に寄せて 1 か所にする案もあるが、web 側の型はラベル・所有者・帯色・
ゲート対応表といった UI 固有の対応表と一体で書かれており、共有化は今回の削除より大きい。
2 か所を直し、型で拾えない漏れはテストと目視で埋める。

`STAGE_LABELS` / `STAGE_OWNER` / `STAGE_SOURCE` は `Record<Stage, ...>` なので、
`Stage` から 2 つ消せば余ったキーを typecheck が検出する。
`GATE_OF_STAGE` は `Partial<Record<...>>` なので検出されない。手で直す。

### Risks / Trade-offs

- 探索の成果物を人が見る機会が `plan-review` の 1 回だけになる → 探索が的外れなまま
  proposal まで進むと、差し戻しの手戻りが大きくなる。`skipGates` の逆で、
  重いカードは人が `startedAt` を打つ前に口頭で握るという運用で受ける。
- `## 探索メモ` が導出の入力でなくなることで、見出しを書いてもボードが動かなくなる →
  README と CLAUDE.md の書き込み境界の記述を同時に直し、AI エージェント向けの
  ハードルール（`.ai-board/cards/board-loop-skill.md`）からも探索レビューの記述を落とす。
- web 側の `Stage` 定義の直し漏れ → `Record<Stage, ...>` の網羅性検査で大半は落ちる。
  落ちない `GATE_OF_STAGE` と `Board.tsx` の `switch` は目視で確認する。

### Migration Plan

デプロイ単位はローカルのプロセス 1 つで、永続データはカードファイルだけである。
カードファイルの書式は変えないので、前方・後方どちらの移行作業も無い。

ロールバックはリバートで足りる。`explore` のレビュー記録を消さないため、
戻したあとも探索レビューの列はそのまま復元される。

## タスク

### 1. 定義を減らす

- [x] 1.1 `src/shared/schemas/common.ts` の `STAGES` から `exploring` と `explore-review` を削り、
      docstring を 7 段へ書き換える。`npm run typecheck` が `Stage` を使う箇所で網羅性エラーを
      出すことを確認する（この時点では失敗が正しい）
- [x] 1.2 `src/cards/models/review.ts` の `REVIEW_GATES` を `['plan']` にし、`explore` を含まない
      ことを確認する

### 2. 導出ルールを差し替える

- [x] 2.1 `stage-resolver.ts` の `RULES` から `explore-review` と `exploring` の 2 本を削除し、
      `planning` の条件を `gates.explore === 'approved'` から `card.startedAt !== null` へ
      差し替える。判定表の docstring も 7 段へ直す
- [x] 2.2 `HUMAN_STAGES` を `['idea', 'planning']` にし、`Facts` から `exploreNote` を、
      `toFacts` から `explore` ゲートの評価を落とす
- [x] 2.3 `review-log.ts` から `hasExploreNote` と探索メモ見出しの定数を削除し、
      `npm run typecheck` で未使用の参照が残っていないことを確認する

### 3. サーバのテストを追従させる

- [x] 3.1 `stage-resolver.test.ts` の `exploring` / `explore-review` のケースを削り、
      「`startedAt` を打つと `planning`」「plan 否決で `planning` へ落ちる」
      「`## 探索メモ` があってもステージが動かない」を検証する
- [x] 3.2 `stage-resolver.test.ts` に `droppableStages` の回帰を足す。成果物が無いカードは
      `['idea', 'planning']`、proposal のあるカードは空配列になること
- [x] 3.3 `board.e2e.test.ts` の explore ゲート前提のケースを plan ゲートへ寄せ、
      `POST /api/cards/:id/reviews` に `gate: "explore"` を送ると 400 が返ることを検証する
- [x] 3.4 `npx vitest run src/board src/cards` が通ることを確認する

### 4. web を追従させる

- [x] 4.1 `src/web/types.ts` の `Stage` から 2 段を削り、`ReviewGate` を `'plan'` にする。
      `STAGE_LABELS` / `STAGE_OWNER` / `STAGE_SOURCE` の余ったキーを落とす
- [x] 4.2 `GATE_OF_STAGE` を `plan-review` だけにし、`HUMAN_STAGES` を
      `['idea', 'planning']` にする（`Partial<Record<...>>` なので型では検出されない）
- [x] 4.3 `Board.tsx` の `patchForStage` の `case 'exploring'` を `case 'planning'` へ変え、
      コメントの「9 列」を 7 列に直す
- [x] 4.4 `detail/BodyEditor.tsx` の placeholder から `## 探索メモ` を外す
- [x] 4.5 `npm run typecheck` が 2 つの tsconfig 両方で通ることを確認する

### 5. ドキュメントと運用ルール

- [x] 5.1 `README.md` の列の表とステージ導出の説明を 7 列・ゲート 1 つへ直す
- [x] 5.2 `CLAUDE.md` の冒頭の列図、列の所有権の表、ステージ導出節、ハードルールから
      探索中 / 探索レビュー / explore ゲートの記述を落とす
- [x] 5.3 `.ai-board/cards/board-loop-skill.md` のハードルールから探索レビューへの言及を落とす

### 6. 品質ゲート

- [x] 6.1 `npm run typecheck && npm run lint && npm test` をすべて通す
- [x] 6.2 `npm run dev` と `npm run dev:web` でボードを開き、7 列が並ぶこと・
      アイデアのカードを計画提案中へドラッグすると `startedAt` が打たれることを確認する
