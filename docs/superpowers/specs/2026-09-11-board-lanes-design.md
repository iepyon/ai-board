# ボードのレーン再設計 — HIL ゲートと AI 主導の状態遷移

- 日付: 2026-09-11
- 状態: 設計合意済み（実装計画は未作成）

## 背景

現行の 7 列（`idea` / `explored` / `proposed` / `impling` / `ai-pr` / `ai-pr-fixed` / `done`）は、
「工程がどこまで進んだか」と「いま誰の番か」を 1 本の軸に畳んでいる。
`explored` は "探索が済んだ" と "人の承認待ち" を兼ね、`proposed` も `ai-pr` も同じ二重性を持つ。

ボードを `/loop` で回す前提に立つと、この二重性が運用上の問題になる。
人が朝ボードを開いたときに「自分が手を動かすべきカード」が一目で分からず、
AI 側も「どこで止まるべきか」を列から読み取れない。

## 目的

1. **人が関与すべき列（HIL）と AI が自走する列を、列そのもので分ける。**
2. **状態遷移はできる限り AI が進める。** 人が動かすのは着手の 1 回だけ。
3. **承認・否決・スキップを一級の概念にする。** 否決には理由が伴い、AI が次の周回で読む。

## レーン

```
[ アイデア ] [ 探索中 ] [ 探索レビュー ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ 検証中 ] [ PR中 ] [ マージ済み ]
     人          AI          人 ★           AI             人 ★          AI        AI      人 ★        —
   ←ドラッグ→                                                                                    中止 → 畳む
```

★ = HIL ゲート。人が承認 / 否決 / 中止を決める。事前宣言でスキップできる。

コード上の識別子:

```ts
export const STAGES = [
  'idea',
  'exploring',
  'explore-review',
  'planning',
  'plan-review',
  'impling',
  'verifying',
  'pr',
  'merged',
] as const;
```

`ai-pr-fixed` は列ではなくなり、`pr` 列内の「再提出済み」バッジに降りる。
判定ロジック（最新コミット時刻 > 最新レビューコメント時刻）は現行の `hasFixAfterReview` をそのまま使う。

## 中核の原則

**`stage` という値をどこにも保存しない。ステージは常に純関数の出力。**

現行 CLAUDE.md の「実態から導出する」を、入力の出所ではなく保存の禁止として定義し直す。
人の判断（着手・承認・否決）もファイル上の痕跡として残るなら、それも実態である。

痕跡の置き場は既存のものを使う。新しいファイル形式は増やさない。

| 列 | 立てる実態 | 書く主体 | 場所 |
|---|---|---|---|
| アイデア | （なし＝既定） | — | — |
| 探索中 | `startedAt` の打刻 | 人 | カード frontmatter |
| 探索レビュー | 本文に `## 探索メモ` | AI | カード本文 |
| 計画提案中 | `## レビュー` の explore 承認 | 人 | カード本文 |
| 計画レビュー | `openspec/changes/<name>/proposal.md` の存在 | AI | `openspec/` |
| 実装中 | `## レビュー` の plan 承認 ＋ `tasks.md` に未完あり | 人 → AI | カード本文 / `openspec/` |
| 検証中 | `tasks.md` が全完了、MR はまだ無い | AI | `openspec/` |
| PR中 | MR が opened | AI | GitLab |
| マージ済み | archive にある、または MR が merged | AI | `openspec/` / GitLab |

`## 探索メモ` は発明ではない。`.ai-board/cards/gitlab-mr-loop.md` が既にこの見出しで探索結果を持ち、
CLAUDE.md の書き込み境界も AI エージェントに「カードの本文・リンク欄のみ」を許している。
探索の成果物置き場は最初からカード本文だった。明文化するだけ。

## レビュー記録のプロトコル

カード本文の `## レビュー` は追記専用のログ。人が判断するゲートは 3 つ（`explore` / `plan` / `pr`）だが、
ログに現れるのは `explore` と `plan` の 2 つ（理由は後述）。

```markdown
## レビュー

### 2026-09-11T04:00Z explore 提出

### 2026-09-11T05:12Z explore 否決

既存の stage-resolver を見ていない。導出ルールとの整合を調べ直して。

### 2026-09-11T09:30Z explore 再提出

### 2026-09-11T09:45Z explore 承認
```

見出し行の書式は `### <ISO8601> <gate> <種別>`。本文が続く場合はその見出しの理由文とする。

| 種別 | 書く主体 | 意味 |
|---|---|---|
| 提出 / 再提出 | AI | 成果物を出した |
| 承認 | 人 | ゲート通過 |
| 否決 | 人 | 差し戻し。理由文が必須 |
| 中止 | 人 | カードの打ち切り |

否決からの復帰を AI の「再提出」追記で表す。
ファイルの mtime を見る方式は成立しない — レビュー記録を書く行為自体で mtime が動くため。

「AI が成果物を出したという事実を AI が記録する」のは、MR にコミットを push するのと同じ性質の行為で、
承認の代行にはあたらない。`.ai-board/cards/board-loop-skill.md` のハードルールを侵さない。

`pr` ゲートだけはログを持たない。実態が GitLab 側（MR の state と note）にあるため。
この非対称は意図的なもので、痕跡がある場所を正とする原則の帰結である。
したがってログを読む `gateState` の対象は `explore` と `plan` の 2 つで、
`pr` ゲートの通過はマージという実態そのものになる。

## スキップ

frontmatter で事前に宣言する。人が「このカードはこのゲートを見ない」と先に決める形。

```yaml
skipGates: [explore, plan]
```

宣言されたゲートは常に通過扱いになり、カードはレビュー列に一瞬も滞留しない。
小さいカードを夜間に回したいときに効く。

レビュー列に来てからボタンで 1 回だけ通す方式は採らない。導出の入力を 2 つに増やさないため。
「見ずに通した」ことを記録に残したい場合は、承認エントリの理由文に書けばよい。

## 導出

ゲートの状態を先に求める純関数を置く。

```
gateState(gate) =
  gate ∈ skipGates                     → approved
  最新エントリが 承認                  → approved
  最新エントリが 否決                  → rejected
  最新エントリが 提出 / 再提出         → submitted
  エントリなし                          → none
```

そのうえで、進んだステージから順に評価し、最初に真になったものを採る（現行の `RULES` 配列の構造を維持）。

| # | stage | 条件 |
|---|---|---|
| 1 | merged | archive に存在、または MR が merged |
| 2 | pr | MR が opened |
| 3 | verifying | `gate(plan) = approved` かつ tasks が `total > 0` かつ `completed = total` |
| 4 | impling | `gate(plan) = approved` |
| 5 | plan-review | `proposal.md` が存在し `gate(plan) ∈ {none, submitted}` |
| 6 | planning | `gate(explore) = approved` |
| 7 | explore-review | 本文に `## 探索メモ` があり `gate(explore) ∈ {none, submitted}` |
| 8 | exploring | `startedAt` が非 null |
| 9 | idea | 既定 |

否決の差し戻しは、専用のルールを持たずに順序で表現される。

- `gate(plan) = rejected` のとき、#4 と #5 が両方外れて #6 `planning` に落ちる。
- `gate(explore) = rejected` のとき、#6 と #7 が外れて #8 `exploring` に落ちる。

`proposal.md` が存在するのに `gate(plan) = none` の場合（AI が提出エントリを書き忘れた場合）も
#5 で `plan-review` に着地する。成果物があることを正とし、ログの欠落で人待ちを取りこぼさない。

## 中止

最新のレビューエントリが「中止」のカードは終端に達する。

列は作らない。`マージ済み`（実際にマージされた）とは意味が違うので混ぜない。
導出結果に `aborted: boolean` を足し、UI は既定でボードから畳む。フィルタで掘り起こせる。

## 人の操作面

人がドラッグできるのは `アイデア ⇄ 探索中` の 1 遷移だけ。`startedAt` の打刻と取り消しに対応する。
他の列は AI の成果物か承認ログが立てるので、ドラッグの着地点が存在しない。

`resolveFloorStage` / `droppableStages` はこの 1 遷移だけを許す形に縮む。
`## 探索メモ` が既に書かれているカードは `アイデア` へ戻せない（下限が `explore-review` になるため）。

レビュー列のカードは **承認 / 否決 / 中止** のボタンを持つ。否決は理由文の入力を必須とする
（空の否決は AI が次の周回で読むものを持たない）。
書き込みは既存の本文書き換え API の系統（`PUT /api/cards/:id/body`）に乗せ、
`## レビュー` セクションへの追記として実装する。

列内の並び替えは AI が行う（優先度順）。人はアイデア列の上から拾って探索中へ落とす。
順序の保存先（カードファイルか別ファイルか）は未決で、既存カード `.ai-board/cards/card-ordering.md` に委ねる。

## カードスキーマの変更

| フィールド | 変更 |
|---|---|
| `explored` | **削除** |
| `implStartedAt` | **削除** |
| `startedAt` | **追加**（`string \| null`、ISO8601） |
| `skipGates` | **追加**（`('explore' \| 'plan')[]`、既定 `[]`） |
| `stageOverride` | **削除** |

`stageOverride` を消す理由。人の判断がすべて実態として記録されるようになるため、
実態と食い違う値を置く動機がなくなる。現行でも API は値の指定を 400 で拒否しており、
`null` のみを受け付ける半端な状態にあった。乖離バッジと `diverged` / `overridden` も同時に消える。

### 移行

既存 16 枚のカードは全て `explored: false` / `implStartedAt: null` なので、実質的な移行は起きない。
それでも規則は定めておく。

- `explored: true` → `startedAt` に `created` の値を入れ、`## レビュー` に explore 承認エントリを追記
- `implStartedAt` が非 null → 同様に plan 承認エントリを追記し、`startedAt` も埋める
- `stageOverride` は破棄

## 影響範囲

- `src/shared/schemas/common.ts` — `STAGES` の入れ替え、`stageRank`
- `src/board/services/stage-resolver.ts` — `RULES` の全面差し替え、`HUMAN_STAGES` の縮小、`hasFixAfterReview` は `pr` 列内のバッジ判定へ用途変更
- `src/cards/models/` — スキーマ、`## レビュー` ログのパーサ（新規）と追記ロジック
- `src/board/controllers/` — 承認 / 否決 / 中止のエンドポイント、エラーマッピングの網羅
- `src/web/` — 9 列への変更、レビューボタン、否決理由の入力、中止カードの折り畳み
- `.ai-board/cards/board-loop-skill.md` — ハードルールの文面（`explored` / `implStartedAt` への言及を差し替え、「提出 / 再提出は書いてよい、承認 / 否決 / 中止は書かない」を明文化）
- `README.md` / `CLAUDE.md` — 7 段の判定表とステージ導出の節

## 未決事項

- 列内の並び順の保存先（`card-ordering` カードに委ねる）
- 検証中に品質ゲートが落ちた事実の表示方法（`loop-activity` カードの `.ai-board/loop.json` に載せる想定）
- AI が MR を作る具体的な手順（`gitlab-mr-loop` カードに委ねる）
