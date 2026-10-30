# board-stages Specification

## Purpose

カードが今どの工程にいて、次に動くのが人か AI かを、カード・計画ファイル・レビュー要求の
実態だけから決める。ステージという値はどこにも保存せず、常に導出の結果として与える。

## Requirements

### Requirement: ステージは保存せず導出する

システムは カードのステージを保存 SHALL NOT、3 つの実態（カード・計画ファイル・
レビュー要求の MR / PR）から毎回導出しなければならない (MUST)。

同じ実態に対しては常に同じステージを返さなければならない (MUST)。

#### Scenario: 同じ実態からは同じステージが出る

- **WHEN** カードの内容と計画ファイルとレビュー要求の状態が変わらないまま、ボードを 2 回取得する
- **THEN** 2 回とも同じステージが返る

#### Scenario: ステージを指定する入力口が無い

- **WHEN** クライアントがカードのステージを直接指定しようとする
- **THEN** そのような入力フィールドは API に存在せず、指定は無視される

### Requirement: 7 段のステージ

システムは カードを次の 7 つのステージのいずれか 1 つに割り当てなければならない (MUST)。
並びはそのまま進行度を表す。

`idea` → `planning` → `plan-review` → `impling` → `verifying` → `pr` → `merged`

このうち `plan-review` / `verifying` / `pr` は人の判断を待つゲートであり、
`planning` / `impling` は AI が自走する工程である。
`plan-review` では計画を読み、`verifying` では実装を動かして振る舞いを確かめ、`pr` ではコードの差分を読む。

#### Scenario: 進行度の順序

- **WHEN** 2 つのステージの進行度を比べる
- **THEN** 上の並びで後ろにあるほうが進んでいると判定される

#### Scenario: 探索の列は存在しない

- **WHEN** ボードが返すステージの一覧を見る
- **THEN** `exploring` と `explore-review` はどこにも現れない

### Requirement: 最も進んだステージが勝つ

システムは 複数の条件が同時に成り立つとき、最も進んだステージを採用しなければならない (MUST)。

#### Scenario: 着手済みで MR も出ている

- **WHEN** カードに着手時刻が記録されており、かつ MR が opened である
- **THEN** ステージは `pr` になる

### Requirement: アイデアと計画提案中は人の着手指示で決まる

システムは カードに着手時刻が記録されていなければ `idea`、記録されていれば
`planning` を返さなければならない (MUST)。ただしより進んだ条件が成り立つ場合はそちらが優先される。

着手時刻は人だけが記録できる (MUST)。AI エージェントはこれを記録 SHALL NOT。

#### Scenario: 着手が指示されていない

- **WHEN** カードに着手時刻が無く、レビュー記録も計画ファイルも MR も無い
- **THEN** ステージは `idea` になる

#### Scenario: 着手が指示された

- **WHEN** カードに着手時刻が記録され、他に何も無い
- **THEN** ステージは `planning` になる

#### Scenario: 計画が否決されても着手時刻は残る

- **WHEN** 着手時刻のあるカードで plan ゲートの最新の記録が否決である
- **THEN** ステージは `planning` に戻る

### Requirement: 計画レビューは計画ファイルの存在で立つ

システムは 計画ファイルが存在し、かつ plan ゲートが未提出か人の判断待ちのとき
`plan-review` を返さなければならない (MUST)。
plan ゲートが通過済み・差し戻し中・保留中のときは `plan-review` を返しては SHALL NOT。

plan ゲートのレビュー記録が 1 件も無い場合も `plan-review` を返さなければならない (MUST)。
成果物が存在する事実を正とし、記録の欠落によって人待ちを取りこぼさないためである。

#### Scenario: 計画が出た

- **WHEN** 計画ファイルが存在し、plan ゲートの記録が無い
- **THEN** ステージは `plan-review` になる

#### Scenario: 計画が否決された

- **WHEN** 計画ファイルが存在し、plan ゲートの最新の記録が否決である
- **THEN** ステージは `planning` に戻る

#### Scenario: 作業者が計画の否決を直しきれずに止まった

- **WHEN** 計画ファイルが存在し、plan ゲートの最新の記録が保留である
- **THEN** ステージは `planning` のままである（止まりとして判断待ちに示される）

### Requirement: 実装中はタスクの進捗で分かれない

システムは plan ゲートが通過済みのとき `impling` を返さなければならない (MUST)。

タスクの進捗を独立したステージとして扱っては SHALL NOT。AI レビューは実装中の
内部工程であり、人が次に見るのは動作確認か PR であってタスクの消化状況ではないためである。
進捗はカード上の表示としてのみ示す。AI レビューは動作確認を頼む前に済ませる。

#### Scenario: タスクに未完がある

- **WHEN** 計画が承認済みで、タスクが 10 件中 3 件完了である
- **THEN** ステージは `impling` になる

#### Scenario: タスクを全部倒した

- **WHEN** 計画が承認済みで、タスクが 10 件中 10 件完了し、MR はまだ無い
- **THEN** ステージは `impling` のままである

#### Scenario: タスクがまだ無い

- **WHEN** 計画が承認済みで、タスクが 0 件である
- **THEN** ステージは `impling` になる

### Requirement: 動作確認は verify の提出で立つ

システムは plan ゲートが通過済みで、かつ verify ゲートが人の判断待ちのとき
`verifying` を返さなければならない (MUST)。

AI は実装を終えると、PR を Draft のまま verify ゲートへ提出する。
Draft の PR があっても、plan ゲートが通過済みのカードを `plan-review` へ戻しては SHALL NOT。

verify ゲートの否決・承認・事前スキップのために専用の規則を足しては SHALL NOT。
どれでも verify ゲートは判断待ちでなくなり、カードは `impling` に落ちる。
承認の後に PR を Ready にするのは AI の作業なので、AI の列で待つ。

#### Scenario: 動作確認を頼んだ

- **WHEN** 計画が承認済みで、verify ゲートの最新の記録が提出であり、PR は Draft である
- **THEN** ステージは `verifying` になる

#### Scenario: 動作確認で否決された

- **WHEN** 計画が承認済みで、verify ゲートの最新の記録が否決である
- **THEN** ステージは `impling` に戻る

#### Scenario: 動作確認で承認された

- **WHEN** 計画が承認済みで、verify ゲートの最新の記録が承認であり、PR は Draft のままである
- **THEN** ステージは `impling` になり、AI が PR を Ready にするのを待つ

#### Scenario: 動作確認を飛ばすと宣言している

- **WHEN** 計画が承認済みで、カードが verify ゲートをスキップすると宣言し、verify の提出の記録がある
- **THEN** ステージは `impling` になる

#### Scenario: 提出のあとに PR が Ready になった

- **WHEN** verify ゲートの最新の記録が提出で、PR が Ready で opened である
- **THEN** ステージは `pr` になる

#### Scenario: 計画が承認されていない

- **WHEN** plan ゲートが判断待ちで、verify の提出の記録がある
- **THEN** ステージは `verifying` にならず、計画の側の列（`plan-review` か `planning`）に留まる

#### Scenario: 作業者が動作確認の否決を直しきれずに止まった

- **WHEN** 計画が承認済みで、verify ゲートの最新の記録が保留である
- **THEN** ステージは `impling` のままである（止まりとして判断待ちに示される）

#### Scenario: 計画を承認し直した

- **WHEN** verify の否決と保留の後に plan が否決され、再提出された計画が承認された
- **THEN** ステージは `impling` になり、verify ゲートは未提出として扱われる

### Requirement: PR 中とマージ済みはレビュー要求と archive で決まる

システムは MR が opened のとき `pr`、MR が merged であるか計画ファイルが archive に
移動しているとき `merged` を返さなければならない (MUST)。

#### Scenario: MR がオープン

- **WHEN** カードに紐付いた MR の状態が opened である
- **THEN** ステージは `pr` になる

#### Scenario: MR がマージされた

- **WHEN** カードに紐付いた MR の状態が merged である
- **THEN** ステージは `merged` になる

#### Scenario: 計画が archive された

- **WHEN** カードの計画ファイルが archive ディレクトリに移動している
- **THEN** ステージは `merged` になる

### Requirement: レビュー後の修正は PR 中のバッジで示す

システムは MR が opened であり、最新のコミットが最新のレビューコメントより新しいとき、
そのカードを再レビュー待ちとして示さなければならない (MUST)。
これは独立したステージとしては扱わない (MUST NOT)。

#### Scenario: 指摘のあとに修正が push された

- **WHEN** MR が opened で、最新コミットの時刻がレビューコメントの時刻より新しい
- **THEN** ステージは `pr` のままで、再レビュー待ちであることが示される

#### Scenario: レビューコメントがまだ無い

- **WHEN** MR が opened で、レビューコメントが 1 件も無い
- **THEN** 再レビュー待ちとしては示されない

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

### Requirement: 止まりはステージとは別の軸で示す

システムは AI の列（`planning` / `impling`）にいて人の判断を待っているカードを、止まりとして示さなければならない (MUST)。
止まりはステージとして扱っては SHALL NOT、保存しても SHALL NOT。ステージは「工程のどこにいるか」、
止まりは「その工程で誰を待っているか」を表し、実態から毎回導出する。

止まりは次のときに立つ。

- `impling` で、人の最新の判断より後に PR が Draft に戻された
- `impling` で、verify ゲートが保留中である
- `planning` で、plan ゲートが保留中である
- `planning` で、plan ゲートが判断待ちなのに、計画ファイルも Draft の PR も見えない

止まりには、人が何をすればよいかを示す理由と、人を待ち始めた時刻を持たせなければならない (MUST)。
止まっているカードは、人の判断を待つカードと同じく判断待ちとして示さなければならない (MUST)。
AI ループの次の一手に、止まっているカードを選んでは SHALL NOT。後ろのカードは選べなければならない (MUST)。

人が承認 / 否決 / 中止を記録すれば、そのエントリが最新になって止まりは外れなければならない (MUST)。
止まりを解くための専用の記録を設けては SHALL NOT。

作成時から Draft の PR は、Draft に戻されたとはみなしては SHALL NOT。

#### Scenario: 作業者が保留を書いて止まった

- **WHEN** `impling` のカードで verify ゲートの最新の記録が保留であり、後ろに `impling` のカードがある
- **THEN** 保留のカードは止まりとして判断待ちに示され、次の一手には後ろのカードが選ばれる

#### Scenario: 動作確認の承認の後に PR が Draft に戻された

- **WHEN** verify ゲートが承認済みで、その承認より後に PR が Draft に戻された
- **THEN** ステージは `impling` のまま止まりとして示され、AI ループは PR を Ready にする手を選ばない

#### Scenario: 動作確認を飛ばすカードの PR が Draft に戻された

- **WHEN** verify ゲートをスキップすると宣言したカードで、plan の承認より後に PR が Draft に戻された
- **THEN** 止まりとして示され、AI ループはそのカードに手を選ばない

#### Scenario: Draft に戻された後に人が判断した

- **WHEN** PR が Draft に戻された後に、人が verify の否決を記録した
- **THEN** 止まりは外れ、AI ループは否決された実装を直す手を選ぶ

#### Scenario: 作成時から Draft の PR

- **WHEN** 計画が承認済みで、PR は作成時から Draft のままであり、一度も Draft に戻されていない
- **THEN** 止まりは立たず、AI ループはタスクを倒す手を選ぶ
