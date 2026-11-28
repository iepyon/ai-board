# board-store Specification

## Purpose

カードの正本を置く場所と、CLI がそれを読み書きする流れを定める。置き場所は差し替えられる 1 つの口に閉じる。

## Requirements

### Requirement: 正本の置き場所

システムは カード・判断・並び順の正本を、`.ai-board/config.yaml` の `github.repository` の GitHub Issue に置かなければならない (MUST)。
カードは 1 枚 1 Issue（ラベル `ai-board`。タイトルがカードのタイトル、本文がカードの本文で、ID・作成時刻・ブランチ・PR 番号などは本文の末尾の隠しコメント）、
判断は その Issue のコメント 1 件 1 判断、並び順と形の版は 専用の Issue の隠しコメントに置かなければならない (MUST)。
`AI_BOARD_STORE` があれば、Issue の代わりにそのパスのディレクトリ（`<コレクション>/<ID>.json`）を使い、GitHub に何も書いては SHALL NOT。
リポジトリ（カード・区切り線・PR の控え・ループの記録）は、置き場所の口（`DocumentStore`）だけを通して読み書きしなければならない (MUST)。

#### Scenario: 置き場所のリポジトリが分からない

- **WHEN** `github.repository` が無く、`AI_BOARD_STORE` も無い状態で `ai-board card list` を走らせる
- **THEN** `github.repository` を書くよう 1 行で伝えて 0 以外で終わる

#### Scenario: GitHub に届かない

- **WHEN** `gh api` が失敗する状態で `ai-board status` を走らせる
- **THEN** GitHub の操作が失敗したことを、HTTP のステータスが分かれば添えて 1 行で伝え、0 以外で終わる

#### Scenario: 置き場所がまだ始まっていない

- **WHEN** 置き場所の Issue が無い状態で `ai-board card list` を走らせる
- **THEN** `ai-board store init` を促して 0 以外で終わる

### Requirement: 信用する作者

システムは Issue とコメントのうち、作者の `authorAssociation` が OWNER・MEMBER・COLLABORATOR のものだけを読まなければならない (MUST)。
ほかの作者の Issue はカードにせず、ほかの作者のコメントは判断にせず、警告して読み飛ばさなければならない (MUST)。
公開リポジトリで外の人が承認などの判断を偽造できないようにするためである。
別のカードの判断を名乗るコメント（隠しコメントの ID が、その Issue のカード ID で始まらないもの）も読んでは SHALL NOT。

#### Scenario: 外の人が承認を名乗るコメントを書いた

- **WHEN** 作者が NONE のコメントに、承認の判断の隠しコメントがある
- **THEN** その判断は読まれず、カードのステージは変わらない

### Requirement: 形の版

システムは 置き場所の `board/meta` に形の版を持ち、自分と違う版の置き場所を読まずに止まらなければならない (MUST)。
版は 4 とする（Issue の置き場所にしたため）。

#### Scenario: 版が違う

- **WHEN** 置き場所の版が 4 でない
- **THEN** 読まずに、版が違うことを伝えて 0 以外で終わる

### Requirement: 固定の seed ファイルから起票する

システムは `main` の `.ai-board/seed/*.md`（`card seed --from` が読む形）を、`ai-board store seed` で起票の書き込みとして置き場所（Issue）へ書かなければならない (MUST)。
既にある ID は飛ばし、`rank`・着手・`## レビュー` は書いては SHALL NOT。
起票は `.ai-board/seed/order.txt`（1 行 1 ID）に書いた順に、書いていない題材はその後にファイル名の順に行い、起票の時刻を前のカードより必ず後にしなければならない (MUST)（アイデアは `rank` が無ければ起票の時刻の順に並ぶので、`rank` を書かずにこの順で並べる）。
`order.txt` に題材の無い ID や同じ ID が 2 度あれば、1 枚も起票してはならない (SHALL NOT)。
起票した後は、seed のファイルを正本として読んでは SHALL NOT。

#### Scenario: 空の置き場所に seed を入れる

- **WHEN** `ai-board store init` の後に `ai-board store seed` を走らせる
- **THEN** seed のカードの Issue ができ、`order.txt` の順にアイデアの列に並ぶ

### Requirement: 書き込みは読み直してから Issue とコメントに書く

システムは CLI の書き込みを、ロックを取り、置き場所を読み直してから、Issue の作成・更新とコメントの追加・削除として行わなければならない (MUST)。
git のコミット・push・fetch、メインのチェックアウトの作業ツリー・index・今のブランチへの変更をしては SHALL NOT。
書く前の検査（判断を書けるか、ゲートの状態など）は、読み直した最新のカードに対して行わなければならない (MUST)。
内容が変わらない文書は書いては SHALL NOT（API の呼び出しを増やさないため）。
途中の API の呼び出しが失敗したら、残りを書かずに失敗を伝えて 0 以外で終わらなければならない (MUST)。次の操作は、実際の Issue から読み直して続ける。
手元に置く控えと記録だけを書くもの、何も書かないものでは、GitHub に書いては SHALL NOT。

#### Scenario: 提出を書く

- **WHEN** `ai-board card submit <id>` を走らせる
- **THEN** そのカードの Issue に判断のコメントが 1 件足され、git は何も変わらない

#### Scenario: 別の PC が先に書いていた

- **WHEN** 書く前に、別の PC が同じ置き場所へ並び順を変えていた
- **THEN** 読み直した置き場所の上で検査して書く

#### Scenario: 途中で失敗した

- **WHEN** カードの Issue は作れたが、続く判断のコメントの追加が失敗する
- **THEN** 失敗を伝えて 0 以外で終わり、次の操作は Issue を読み直した状態から続ける

### Requirement: 共有しない控えと記録は手元に置く

システムは マージ済みの PR の控えとループの記録を、Issue に書いては SHALL NOT。メインのチェックアウトの `.ai-board/local/`（git に載せない）に置かなければならない (MUST)。
`AI_BOARD_STORE` を指したときは、そのパスの隣の別のディレクトリに置かなければならない (MUST)（試しの記録が本物に混ざらないため）。
控えが無ければ GitHub から引き直さなければならない (MUST)。

#### Scenario: 別の PC で初めて status を走らせる

- **WHEN** `.ai-board/local/` が空の PC で `ai-board status` を走らせる
- **THEN** マージ済みの PR を GitHub から引き直し、Issue には何も書かない

### Requirement: PR 中とマージ済みは PR と main の計画で決まる

システムは PR が open で Draft でない（Ready の）とき `pr`、PR がマージされたか、main に `.ai-board/cards/<id>/plan.md` があるとき `merged` を返さなければならない (MUST)。
main の計画は、作業ツリーではなく、`origin` の `main` を専用の参照（`refs/ai-board/store`）へ fetch して、その参照から読まなければならない (MUST)。メインのチェックアウトがほかのブランチにいても、そのブランチの計画でマージ済みに見えてはならないためである。
計画の時刻は、その参照で計画ファイルを最後に変えたコミットの時刻としなければならない (MUST)。
main を読めなくても（届かない・リモートが無い）、ボードは開き、警告を出さなければならない (MUST)。マージ済みは PR がマージされたことでも立つ。
open でも Draft の PR は `pr` を立てない。計画の成果物か、実装中の PR だからである。
計画はカードのブランチに載り、main にはマージでだけ入るので、main の計画をマージ済みの印に使う。
AI は実装と AI レビューを終えたら、動かした証拠を PR の本文に書き、計画の末尾に `## 締め` の節を足して PR を Ready にする。

#### Scenario: PR が Ready で出ている

- **WHEN** カードに紐付いた PR が open で Draft でない
- **THEN** ステージは `pr` になる

#### Scenario: PR が Draft のまま

- **WHEN** 計画が承認済みで、カードに紐付いた PR が open で Draft である
- **THEN** ステージは `pr` にならず、`impling` になる

#### Scenario: PR がマージされた

- **WHEN** カードに紐付いた PR がマージされている
- **THEN** ステージは `merged` になる

#### Scenario: 計画が main に入った

- **WHEN** fetch した main の参照に `.ai-board/cards/<id>/plan.md` がある
- **THEN** ステージは `merged` になる

#### Scenario: メインのチェックアウトがほかのブランチにいる

- **WHEN** メインのチェックアウトがカードのブランチにいて、作業ツリーに `.ai-board/cards/<id>/plan.md` があるが、fetch した main の参照には無い
- **THEN** ステージは `merged` にならない
