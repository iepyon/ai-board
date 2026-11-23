# board-store Specification

## Purpose

カードの正本を置く場所と、CLI がそれを読み書きする流れを定める。置き場所は差し替えられる 1 つの口に閉じる。

## Requirements

### Requirement: 正本の置き場所

システムは カード・判断・並び順の正本を、設定で指す git のリポジトリの 1 つのブランチ（既定は `origin` の `main`）の `.ai-board/` の下に、ファイル（`board.yaml`・`order.yaml`・`cards/<id>/card.md`・`cards/<id>/log/`）として置かなければならない (MUST)。
リモートとブランチは `main` の `.ai-board/config.yaml` の `store.remote` と `store.branch` で指し、書かなければ `origin` と `main` を使わなければならない (MUST)。
`AI_BOARD_STORE` があれば、そのパスの git リポジトリを置き場所のリモートとして使わなければならない (MUST)。
リポジトリ（カード・区切り線・PR の控え・ループの記録）は、置き場所の口（`DocumentStore`）だけを通して読み書きしなければならない (MUST)。

#### Scenario: 置き場所のリモートが無い

- **WHEN** `store.remote` の指すリモートがリポジトリに無い状態で `ai-board status` を走らせる
- **THEN** リモートが無いことと、設定の仕方を 1 行で伝えて 0 以外で終わる

#### Scenario: 置き場所がまだ始まっていない

- **WHEN** 置き場所のブランチに `.ai-board/board.yaml` が無い状態で `ai-board card list` を走らせる
- **THEN** `ai-board store init` を促して 0 以外で終わる

### Requirement: 形の版

システムは 置き場所の `.ai-board/board.yaml` に形の版を持ち、自分と違う版の置き場所を読まずに止まらなければならない (MUST)。
版は 3 のままとする（文書の形は変えないため）。

#### Scenario: 版が違う

- **WHEN** 置き場所の `board.yaml` の版が 3 でない
- **THEN** 読まずに、版が違うことを伝えて 0 以外で終わる

### Requirement: 固定の seed ファイルから起票する

システムは `main` の `.ai-board/seed/*.md`（`card seed --from` が読む形）を、`ai-board store seed` で起票の書き込みとして置き場所のブランチへ push しなければならない (MUST)。
既にある ID は飛ばし、`rank`・着手・`## レビュー` は書いては SHALL NOT。
起票は `.ai-board/seed/order.txt`（1 行 1 ID）に書いた順に、書いていない題材はその後にファイル名の順に行い、起票の時刻を前のカードより必ず後にしなければならない (MUST)（アイデアは `rank` が無ければ起票の時刻の順に並ぶので、`rank` を書かずにこの順で並べる）。
`order.txt` に題材の無い ID や同じ ID が 2 度あれば、1 枚も起票してはならない (SHALL NOT)。

#### Scenario: 空の置き場所に seed を入れる

- **WHEN** `ai-board store init` の後に `ai-board store seed` を走らせる
- **THEN** 置き場所のブランチに seed のカードの `card.md` を足すコミットが push され、`order.txt` の順にアイデアの列に並ぶ

### Requirement: 書き込みは置き場所のブランチへのコミットとして push する

システムは CLI の書き込みを、`git fetch` で取った置き場所のブランチ（既定は `origin` の `main`）の先頭の上に、置き場所のファイルだけを変えるコミットを 1 つ作り、push しなければならない (MUST)。
メインのチェックアウトの作業ツリー・index・今のブランチを変えては SHALL NOT。
push が先を越されて拒まれたら、取り直した先頭の上で書く前の検査からやり直さなければならない (MUST)。3 回やり直しても通らなければ、書かずに 0 以外で終わらなければならない (MUST)。
push が通らず、取り直した先頭が動いていなければ（権限が無い・保護されている・届かない）、やり直さずに push の失敗を伝えて 0 以外で終わらなければならない (MUST)。
書く前の検査（判断を書けるか、ゲートの状態など）は、取り直した最新のカードに対して行わなければならない (MUST)。
置き場所のファイルを 1 つも変えない書き込み（手元に置く控えと記録だけを書くもの、何も書かないもの）では、fetch・コミット・push をしては SHALL NOT。

#### Scenario: 提出を書く

- **WHEN** `ai-board card submit <id>` を走らせる
- **THEN** 置き場所のブランチに判断のファイル 1 件を足すコミットが push され、メインのチェックアウトの作業ツリーは変わらない

#### Scenario: 先を越された

- **WHEN** push の前に、別の PC が同じ置き場所のブランチへ並び順を変えるコミットを push していた
- **THEN** 取り直した先頭の上で検査と書き込みをやり直し、両方の変更が置き場所に残る

### Requirement: カードのブランチは置き場所のファイルを変えない

システムは `ai-board store check-branch <branch>` で、置き場所のブランチとの分岐点と `<branch>` の差分（`git diff --name-only <分岐点> <branch>`）に置き場所のファイル（`board.yaml`・`order.yaml`・`cards/<id>/card.md`・`cards/<id>/log/`）があれば、そのファイルを並べて 0 以外で終わらなければならない (MUST)。
コミットごとに見ては SHALL NOT（main を取り込んだマージのコミットで誤って止めないため）。
`cards/<id>/plan.md` の変更は拒んでは SHALL NOT（計画はカードのブランチに載せるため）。

#### Scenario: ブランチでカードを書き換えた

- **WHEN** カードのブランチで `.ai-board/cards/<id>/card.md` を変えたコミットがあり、`ai-board store check-branch <branch>` を走らせる
- **THEN** 変えたファイルを並べて 0 以外で終わる

#### Scenario: main を取り込んだブランチ

- **WHEN** カードのブランチが、置き場所のファイルを変えた main をマージで取り込んでいるが、ブランチ自身は置き場所のファイルを変えていない
- **THEN** 0 で終わる

### Requirement: 共有しない控えと記録は手元に置く

システムは マージ済みの PR の控えとループの記録を、置き場所のブランチに書いては SHALL NOT。メインのチェックアウトの `.ai-board/local/`（git に載せない）に置かなければならない (MUST)。
`AI_BOARD_STORE` を指したときは、そのパスの隣の別のディレクトリに置かなければならない (MUST)（試しの記録が本物に混ざらないため）。
控えが無ければ GitHub から引き直さなければならない (MUST)。

#### Scenario: 別の PC で初めて status を走らせる

- **WHEN** `.ai-board/local/` が空の PC で `ai-board status` を走らせる
- **THEN** マージ済みの PR を GitHub から引き直し、置き場所のブランチにはコミットを足さない
