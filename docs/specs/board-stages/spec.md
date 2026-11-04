# board-stages Specification

## Purpose

カードが今どの工程にいて、次に動くのが人か AI かを、カード・計画ファイル・GitHub の PR の
実態だけから決める。ステージという値はどこにも保存せず、常に導出の結果として与える。

## Requirements

### Requirement: ステージは保存せず導出する

システムは カードのステージを保存 SHALL NOT、3 つの実態（カード・計画ファイル・
GitHub の PR）から毎回導出しなければならない (MUST)。

同じ実態に対しては常に同じステージを返さなければならない (MUST)。

#### Scenario: 同じ実態からは同じステージが出る

- **WHEN** カードの内容と計画ファイルと PR の状態が変わらないまま、ボードを 2 回取得する
- **THEN** 2 回とも同じステージが返る

#### Scenario: ステージを指定する入力口が無い

- **WHEN** クライアントがカードの更新でステージを直接指定しようとする
- **THEN** そのような入力フィールドは API に存在しない。ほかのフィールドと一緒に送れば `stage` だけが無視され、
  `stage` だけを送れば更新するフィールドが無いとして 400 が返る

### Requirement: 6 段のステージ

システムは カードを次の 6 つのステージのいずれか 1 つに割り当てなければならない (MUST)。
並びはそのまま進行度を表す。

`idea` → `planning` → `plan-review` → `impling` → `pr` → `merged`

このうち `plan-review` / `pr` は人の判断を待つゲートであり、
`planning` / `impling` は AI が自走する工程である。
`plan-review` では計画を読み、`pr` では AI が PR の本文に書いた動作確認の結果を読み、必要なら実装を動かし、コードの差分を読む。

#### Scenario: 進行度の順序

- **WHEN** 2 つのステージの進行度を比べる
- **THEN** 上の並びで後ろにあるほうが進んでいると判定される

#### Scenario: 探索の列は存在しない

- **WHEN** ボードが返すステージの一覧を見る
- **THEN** `exploring` と `explore-review` はどこにも現れない

#### Scenario: 動作確認の列は存在しない

- **WHEN** ボードが返すステージの一覧を見る
- **THEN** `verifying` はどこにも現れない

### Requirement: 最も進んだステージが勝つ

システムは 複数の条件が同時に成り立つとき、最も進んだステージを採用しなければならない (MUST)。

#### Scenario: 着手済みで PR も Ready になっている

- **WHEN** カードに着手時刻が記録されており、かつ PR が open で Draft でない
- **THEN** ステージは `pr` になる

### Requirement: アイデアと計画提案中は人の着手指示で決まる

システムは カードに着手時刻が記録されていなければ `idea`、記録されていれば
`planning` を返さなければならない (MUST)。ただしより進んだ条件が成り立つ場合はそちらが優先される。

着手時刻は人だけが記録できる (MUST)。AI エージェントはこれを記録 SHALL NOT。

#### Scenario: 着手が指示されていない

- **WHEN** カードに着手時刻が無く、レビュー記録も計画ファイルも PR も無い
- **THEN** ステージは `idea` になる

#### Scenario: 着手が指示された

- **WHEN** カードに着手時刻が記録され、他に何も無い
- **THEN** ステージは `planning` になる

#### Scenario: 計画が否決されても着手時刻は残る

- **WHEN** 着手時刻のあるカードで plan ゲートの最新の記録が否決である
- **THEN** ステージは `planning` に戻る

### Requirement: 計画レビューは計画の成果物の存在で立つ

システムは 計画の成果物があり、かつ plan ゲートが未提出か人の判断待ちのとき
`plan-review` を返さなければならない (MUST)。
plan ゲートが通過済み・差し戻し中・保留中のときは `plan-review` を返しては SHALL NOT。

計画の成果物とは、計画ファイルか、open で Draft の PR のどちらかである。
AI は計画をコミットした時点で Draft の PR を出す。計画ファイルはそのブランチにあり、
ボードを動かすチェックアウトからは見えないことが多いので、Draft の PR も計画の成果物として扱う。

plan ゲートのレビュー記録が 1 件も無い場合も `plan-review` を返さなければならない (MUST)。
成果物が存在する事実を正とし、記録の欠落によって人待ちを取りこぼさないためである。

#### Scenario: 計画が出た

- **WHEN** 計画ファイルが存在し、plan ゲートの記録が無い
- **THEN** ステージは `plan-review` になる

#### Scenario: 計画の Draft の PR が出た

- **WHEN** 計画ファイルは見えないが、カードに open で Draft の PR が紐付き、plan ゲートの記録が提出である
- **THEN** ステージは `plan-review` になる

#### Scenario: 計画が否決された

- **WHEN** 計画ファイルが存在し、plan ゲートの最新の記録が否決である
- **THEN** ステージは `planning` に戻る

#### Scenario: AI が計画の否決を直しきれずに止まった

- **WHEN** 計画ファイルが存在し、plan ゲートの最新の記録が保留である
- **THEN** ステージは `planning` のままである（止まりは board-hold の仕様で示す）

### Requirement: 実装中はタスクの進捗で分かれない

システムは plan ゲートが通過済みのとき `impling` を返さなければならない (MUST)。

タスクの進捗を独立したステージとして扱っては SHALL NOT。AI レビューは実装中の
内部工程であり、人が次に見るのは PR であってタスクの消化状況ではないためである。
進捗はカード上の表示としてのみ示す。AI レビューは PR を Ready にする前に済ませる。
AI レビューの指摘のうち直すものは、計画の末尾の `## AI レビュー` 節にチェックボックスで書かれ、
タスクと同じく進捗に数えられる。レビュー済みかどうかを表す状態やステージは持たない。

#### Scenario: タスクに未完がある

- **WHEN** 計画が承認済みで、タスクが 10 件中 3 件完了である
- **THEN** ステージは `impling` になる

#### Scenario: タスクを全部倒した

- **WHEN** 計画が承認済みで、タスクが 10 件中 10 件完了し、PR はまだ無い
- **THEN** ステージは `impling` のままである

#### Scenario: AI レビューの直す指摘が残っている

- **WHEN** 計画が承認済みで、タスクは全部完了し、`## AI レビュー` 節の直す指摘が 2 件未完である
- **THEN** ステージは `impling` のままである

#### Scenario: タスクがまだ無い

- **WHEN** 計画が承認済みで、タスクが 0 件である
- **THEN** ステージは `impling` になる

### Requirement: 廃止した verify ゲートの記録はステージに効かない

システムは カードに残る廃止した verify ゲートの記録（提出・否決・承認・保留）と、`skipGates` に残る `verify` を、
ステージの導出に使っては SHALL NOT。記録は消さずに残す。

#### Scenario: verify の提出が残っている

- **WHEN** 計画が承認済みで、verify ゲートの提出の記録が残っており、PR は Draft である
- **THEN** ステージは `impling` になる

#### Scenario: verify の承認が残っていて PR が Ready になった

- **WHEN** 計画が承認済みで、verify ゲートの承認の記録が残っており、PR が open で Draft でない
- **THEN** ステージは `pr` になる

### Requirement: PR 中とマージ済みは PR と archive で決まる

システムは PR が open で Draft でない（Ready の）とき `pr`、PR がマージされたか計画ファイルが archive に
移動しているとき `merged` を返さなければならない (MUST)。
open でも Draft の PR は `pr` を立てない。計画の成果物か、実装中の PR だからである。
AI は実装と AI レビューを終えたら、動かした証拠を PR の本文に書き、計画を archive して PR を Ready にする。

#### Scenario: PR が Ready で出ている

- **WHEN** カードに紐付いた PR が open で Draft でない
- **THEN** ステージは `pr` になる

#### Scenario: PR が Draft のまま

- **WHEN** 計画が承認済みで、カードに紐付いた PR が open で Draft である
- **THEN** ステージは `pr` にならず、`impling` になる

#### Scenario: PR がマージされた

- **WHEN** カードに紐付いた PR がマージされている
- **THEN** ステージは `merged` になる

#### Scenario: 計画が archive された

- **WHEN** カードの計画ファイルが archive ディレクトリに移動している
- **THEN** ステージは `merged` になる

### Requirement: レビュー後の修正は PR 中のバッジで示す

システムは `pr` のカードで、PR の最新のコミットが最新のレビューコメントより新しいとき、
そのカードを再レビュー待ちとして示さなければならない (MUST)。
これは独立したステージとしては扱わない (MUST NOT)。

#### Scenario: 指摘のあとに修正が push された

- **WHEN** PR が Ready で open であり、最新コミットの時刻がレビューコメントの時刻より新しい
- **THEN** ステージは `pr` のままで、再レビュー待ちであることが示される

#### Scenario: レビューコメントがまだ無い

- **WHEN** PR が Ready で open であり、レビューコメントが 1 件も無い
- **THEN** 再レビュー待ちとしては示されない
