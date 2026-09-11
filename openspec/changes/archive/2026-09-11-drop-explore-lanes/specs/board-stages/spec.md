## ADDED Requirements

### Requirement: 7 段のステージ

システムは カードを次の 7 つのステージのいずれか 1 つに割り当てなければならない (MUST)。
並びはそのまま進行度を表す。

`idea` → `planning` → `plan-review` → `impling` → `verifying` → `pr` → `merged`

このうち `plan-review` / `pr` は人の判断を待つゲートであり、
`planning` / `impling` / `verifying` は AI が自走する工程である。

#### Scenario: 進行度の順序

- **WHEN** 2 つのステージの進行度を比べる
- **THEN** 上の並びで後ろにあるほうが進んでいると判定される

#### Scenario: 探索の列は存在しない

- **WHEN** ボードが返すステージの一覧を見る
- **THEN** `exploring` と `explore-review` はどこにも現れない

### Requirement: アイデアと計画提案中は人の着手指示で決まる

システムは カードに着手時刻が記録されていなければ `idea`、記録されていれば
`planning` を返さなければならない (MUST)。ただしより進んだ条件が成り立つ場合はそちらが優先される。

着手時刻は人だけが記録できる (MUST)。AI エージェントはこれを記録 SHALL NOT。

#### Scenario: 着手が指示されていない

- **WHEN** カードに着手時刻が無く、レビュー記録も openspec も MR も無い
- **THEN** ステージは `idea` になる

#### Scenario: 着手が指示された

- **WHEN** カードに着手時刻が記録され、他に何も無い
- **THEN** ステージは `planning` になる

#### Scenario: 計画が否決されても着手時刻は残る

- **WHEN** 着手時刻のあるカードで plan ゲートの最新の記録が否決である
- **THEN** ステージは `planning` に戻る

### Requirement: 人が動かせるのはアイデアと計画提案中の間だけ

システムは 人が手で動かせる遷移を `idea` と `planning` の間に限定しなければならない (MUST)。
それ以外の列へのドロップは受け付けては SHALL NOT。実態が変わらないため着地できないからである。

さらにシステムは AI の成果物と人のレビュー記録が課す下限より手前の列へ戻すことを
許して SHALL NOT。下限は、着手時刻を外したカードに同じ導出を適用した結果とする。

#### Scenario: まだ何も成果物が無い

- **WHEN** カードにレビュー記録も openspec も MR も無い
- **THEN** `idea` と `planning` の両方へ手で動かせる

#### Scenario: proposal が出ている

- **WHEN** カードの change に proposal が存在する
- **THEN** 下限は `plan-review` となり、手で動かせる先は 1 つも無い

#### Scenario: MR が出ている

- **WHEN** カードに opened の MR が紐付いている
- **THEN** 下限は `pr` となり、手で動かせる先は 1 つも無い

## REMOVED Requirements

### Requirement: 9 段のステージ

**Reason**: `exploring` と `explore-review` を削除し 7 段にするため。
**Migration**: 新しい要件「7 段のステージ」を参照する。`exploring` / `explore-review` にいた
カードは、着手時刻の有無に応じて `planning` または `idea` として現れる。

### Requirement: アイデアと探索中は人の着手指示で決まる

**Reason**: 着手時刻が立てるステージを `exploring` から `planning` へ変えたため。
**Migration**: 新しい要件「アイデアと計画提案中は人の着手指示で決まる」を参照する。
着手時刻そのものの意味と、人だけが記録できるという制約は変わらない。

### Requirement: 探索レビューは探索メモの存在で立つ

**Reason**: explore ゲートを廃止し、探索メモをステージ導出の入力から外したため。
**Migration**: 探索の成果は計画提案（proposal）の一部として `plan-review` で一度に判断する。
カード本文に残る探索メモの見出しと `explore` ゲートのレビュー記録は、ステージに影響しない。

### Requirement: 人がドラッグで動かせるのは着手の 1 遷移だけ

**Reason**: 人がドラッグできる 1 遷移の着地先が `exploring` から `planning` へ変わり、
下限を示すシナリオも探索メモを前提にしていたため。
**Migration**: 新しい要件「人が動かせるのはアイデアと計画提案中の間だけ」を参照する。
「ドラッグは 1 遷移だけ」「下限より手前へは戻せない」という制約そのものは変わらない。
