# board-manual-start Specification

## Purpose

人がカードの列を手で動かせる範囲を決める。人が動かせるのは着手の指示（`startedAt`）だけで、
AI の成果物と人のレビュー記録が課す下限より手前へは戻せない。

## Requirements

### Requirement: 人が動かせるのはアイデアと計画提案中の間だけ

システムは 人が手で動かせる遷移を `idea` と `planning` の間に限定しなければならない (MUST)。
それ以外の列へのドロップは受け付けては SHALL NOT。実態が変わらないため着地できないからである。

さらにシステムは AI の成果物と人のレビュー記録が課す下限より手前の列へ戻すことを
許して SHALL NOT。下限は、着手時刻を外したカードに同じ導出を適用した結果とする。

#### Scenario: まだ何も成果物が無い

- **WHEN** カードにレビュー記録も計画ファイルも MR も無い
- **THEN** `idea` と `planning` の両方へ手で動かせる

#### Scenario: 計画が出ている

- **WHEN** カードの計画ファイルが存在する
- **THEN** 下限は `plan-review` となり、手で動かせる先は 1 つも無い

#### Scenario: MR が出ている

- **WHEN** カードに opened の MR が紐付いている
- **THEN** 下限は `pr` となり、手で動かせる先は 1 つも無い
