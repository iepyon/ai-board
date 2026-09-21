## MODIFIED Requirements

### Requirement: ステージは保存せず導出する

システムは カードのステージを保存 SHALL NOT、3 つの実態（カードファイル・openspec の
change ディレクトリ・レビュー要求の取得先が返す状態）から毎回導出しなければならない (MUST)。

同じ実態に対しては常に同じステージを返さなければならない (MUST)。

取得先が GitLab か GitHub かによって導出の規則を変えては SHALL NOT。
導出は取得先が返す状態の意味だけに依存する。

#### Scenario: 同じ実態からは同じステージが出る

- **WHEN** カードの内容と openspec とレビュー要求の状態が変わらないまま、ボードを 2 回取得する
- **THEN** 2 回とも同じステージが返る

#### Scenario: ステージを指定する入力口が無い

- **WHEN** クライアントがカードのステージを直接指定しようとする
- **THEN** そのような入力フィールドは API に存在せず、指定は無視される

#### Scenario: 取得先が違っても同じステージが出る

- **WHEN** 同じ意味の状態を GitLab から取得した場合と GitHub から取得した場合を比べる
- **THEN** 導出されるステージは同じになる

## REMOVED Requirements

### Requirement: PR 中とマージ済みは GitLab の実態で決まる

**Reason**: 取得先が GitLab に限定されなくなったため、要件名と本文を取得先非依存の
記述へ改める。判定の規則そのものは変えていない。

**Migration**: 同じ内容を「PR 中とマージ済みはレビュー要求の実態で決まる」として
ADDED Requirements に置いた。GitLab の Merge Request はそのまま該当し、
GitHub の Pull Request も同じ規則で判定される。

## ADDED Requirements

### Requirement: PR 中とマージ済みはレビュー要求の実態で決まる

システムは カードに紐付くレビュー要求が open のとき `pr`、merged であるか
change が archive に移動しているとき `merged` を返さなければならない (MUST)。

レビュー要求が GitLab の Merge Request か GitHub の Pull Request かは、
この判定に影響しては SHALL NOT。

#### Scenario: レビュー要求がオープン

- **WHEN** カードに紐付いたレビュー要求の状態が open である
- **THEN** ステージは `pr` になる

#### Scenario: レビュー要求がマージされた

- **WHEN** カードに紐付いたレビュー要求の状態が merged である
- **THEN** ステージは `merged` になる

#### Scenario: change が archive された

- **WHEN** カードに紐付いた change が archive ディレクトリに移動している
- **THEN** ステージは `merged` になる

#### Scenario: 取得先が無効でも archive は効く

- **WHEN** レビュー要求の取得先が未設定で、change が archive ディレクトリに移動している
- **THEN** ステージは `merged` になる
