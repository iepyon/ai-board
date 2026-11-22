# 置き場所に git の main の Markdown を足して既定にし、計画をカードのディレクトリに置く

## 提案

### Why

カードの正本は Artifact の DB にある（ADR 0020）。しかし使う場では claude.ai が使えず、DB に届かない。
使うのは 3 人で、1 つのボードを共有し、各自のローカル PC で動かす。GitHub は使える。ボードはブラウザで見るだけで、判断はチャットで頼む。
git の main の普通のファイルに置けば、共有・楽観ロック・判断の履歴を git が兼ね、写し・送る箱・Claude による送り出しが要らなくなる（ADR 0021、提案）。
一方で、claude.ai を使える場で Artifact の置き場所を使う人もいるので、置き場所の種類を設定で選べるようにし、既定を git にする。

### What Changes

- **置き場所の種類を `.ai-board/config.yaml` の `store.kind`（`git` / `artifact`）で選び、既定を `git` にする。** 種類で変わるのは `DocumentStore` の実装と、Claude が CLI の前後に取り込み・送り出しをするかだけで、その上の usecase・検査・ステージの導出・計画の置き場所は共通にする
- **git の置き場所: main のファイル。** `DocumentStore` の新しい実装 `GitDocumentStore` を作り、Artifact の実装 `ArtifactMirrorStore` と並べる。
  読み出しは `git fetch` した `<remote>/<branch>` のツリーから、書き込みはそのツリーの上にコミットを作って push する。メインのチェックアウトの作業ツリーには触らない
- ファイルの形は、今の `card-files.ts`（以前のデータ用ブランチの形）をそのまま使う

  ```
  .ai-board/board.yaml                         形の版（board/meta）
  .ai-board/order.yaml                         並び順とアイデアの区切り線
  .ai-board/cards/<id>/card.md                 frontmatter（id, title, created, skipGates, branch, pr）と本文
  .ai-board/cards/<id>/log/<時刻>.<gate>.<種別>.md   判断・着手 1 件
  .ai-board/cards/<id>/plan.md                 仕様つきの計画（カードのブランチ → PR）
  .ai-board/local/                             git に載せない。PR の控え・ループの記録・ロック・ボードの HTML
  ```

- **計画を `.ai-board/cards/<id>/plan.md` に置き、main にあればマージ済みとする。** `.ai-board/plans/` と `archive/` へ移す手順をなくす。
  締めの段は、移す代わりに計画の末尾に `## 締め` の節を足す。ブランチの「締め済み」はこの節で読む
- **main の計画は作業ツリーではなく git の参照から読む。** git では fetch した置き場所の参照、artifact では手元の `main` の参照を `ls-tree` で読み、時刻はその計画を最後に変えたコミットの時刻にする
- **今の置き方の計画も読み続ける（互換）。** main の `plans/<id>.md`（計画レビュー）と `plans/archive/<id>.md`（マージ済み）、カードのブランチの `plans/<id>.md` と `plans/archive/<id>.md`（締め済み）も読む。artifact で使っている最中のボードのカードがステージを失わないためである
- 置き場所の口 `DocumentStore` の `check()` を非同期にする（git の実装が fetch するため）
- **カードのブランチは置き場所のファイルを変えない。** `ai-board store check-branch <branch>` で検査し、ループは push の前に走らせる
- **artifact の置き場所は今のまま残す。** 写し・送る箱とその CLI（`store pull` / `outbox` / `ack` / `discard` / `import`）、`board-store` のスキル、`ArtifactData` の hook は、`store.kind: artifact` のときに使う。git のときは写しと送る箱を使わず、人のいない `/loop` からも書ける
- 手順書は `ai-board store kind`（`git` か `artifact` を 1 行で出す）を見て、`artifact` のときだけ `board-store` の取り込み・送り出しを挟む
- マージ済みの PR の控えとループの記録は、artifact では今どおり置き場所に置き、git では各 PC の `.ai-board/local/` に置いて共有しない
- `.ai-board/seed/` は配る seed として残す。`store init` と `store seed` はどちらの置き場所でも使え、git ではこの 2 つで main に最初のカードを入れる
- `board-view` のスキルは、artifact では今どおり Artifact で公開し、git では `.ai-board/local/board.html` に書き出してパスを伝える
- `config.yaml` の `store` に `kind`（既定 `git`）・`remote`（既定 `origin`）・`branch`（既定 `main`）を足す。`url` は artifact のときだけ使う。`AI_BOARD_STORE` は、git では試しに使う git リポジトリ（bare）のパスを、artifact では今どおり写しのディレクトリを指す

### Impact

- コード: `src/infrastructure/`（置き場所・設定・cli-runner）、`src/cards/`（CLI・composition・repositories）、`src/board/`（計画のリポジトリ・段・止まり・composition）
- 手順書: `.claude/skills/board-loop/`・`board-decide`・`board-view`・`board-store`（artifact のときだけ使う）・`.claude/agents/board-reviewer.md`・`.claude/settings.json`
- ドキュメント: `CLAUDE.md`・`README.md`・`docs/reference.md`・`REVIEW.md`・ADR（0004・0014・0019・0020・0021）・`docs/specs/`
- 互換: 形の版は 3 のまま変えない（文書の形はどちらの置き場所でも同じ）。`store.kind` を書いていない今の `config.yaml` は git として読む。このリポジトリの Artifact の置き場所はまだ用意されていない（`store.url` が null）ので、移すデータは無い

## 仕様の差分

### board-store（`docs/specs/board-store/spec.md`）

#### ADDED Requirements

##### Requirement: 書き込みは置き場所のブランチへのコミットとして push する

システムは git の置き場所では、CLI の書き込みを、`git fetch` で取った置き場所のブランチ（既定は `origin` の `main`）の先頭の上に、置き場所のファイルだけを変えるコミットを 1 つ作り、push しなければならない (MUST)。
メインのチェックアウトの作業ツリー・index・今のブランチを変えては SHALL NOT。
push が先を越されて拒まれたら、取り直した先頭の上で書く前の検査からやり直さなければならない (MUST)。3 回やり直しても通らなければ、書かずに 0 以外で終わらなければならない (MUST)。
書く前の検査（判断を書けるか、ゲートの状態など）は、取り直した最新のカードに対して行わなければならない (MUST)。
置き場所のファイルを 1 つも変えない書き込み（手元に置く控えと記録だけを書くもの、何も書かないもの）では、fetch・コミット・push をしては SHALL NOT。

###### Scenario: 提出を書く

- **WHEN** `ai-board card submit <id>` を走らせる
- **THEN** 置き場所のブランチに判断のファイル 1 件を足すコミットが push され、メインのチェックアウトの作業ツリーは変わらない

###### Scenario: 先を越された

- **WHEN** push の前に、別の PC が同じ置き場所のブランチへ並び順を変えるコミットを push していた
- **THEN** 取り直した先頭の上で検査と書き込みをやり直し、両方の変更が置き場所に残る

##### Requirement: カードのブランチは置き場所のファイルを変えない

システムは `ai-board store check-branch <branch>` で、置き場所のブランチとの分岐点と `<branch>` の差分（`git diff --name-only <分岐点> <branch>`）に置き場所のファイル（`board.yaml`・`order.yaml`・`cards/<id>/card.md`・`cards/<id>/log/`）があれば、そのファイルを並べて 0 以外で終わらなければならない (MUST)。
コミットごとに見ては SHALL NOT（main を取り込んだマージのコミットで誤って止めないため）。
`cards/<id>/plan.md` の変更は拒んでは SHALL NOT（計画はカードのブランチに載せるため）。

###### Scenario: ブランチでカードを書き換えた

- **WHEN** カードのブランチで `.ai-board/cards/<id>/card.md` を変えたコミットがあり、`ai-board store check-branch <branch>` を走らせる
- **THEN** 変えたファイルを並べて 0 以外で終わる

###### Scenario: main を取り込んだブランチ

- **WHEN** カードのブランチが、置き場所のファイルを変えた main をマージで取り込んでいるが、ブランチ自身は置き場所のファイルを変えていない
- **THEN** 0 で終わる

##### Requirement: 共有しない控えと記録は手元に置く

システムは git の置き場所では、マージ済みの PR の控えとループの記録を、置き場所のブランチに書いては SHALL NOT。メインのチェックアウトの `.ai-board/local/`（git に載せない）に置かなければならない (MUST)。
控えが無ければ GitHub から引き直さなければならない (MUST)。

###### Scenario: 別の PC で初めて status を走らせる

- **WHEN** git の置き場所で、`.ai-board/local/` が空の PC で `ai-board status` を走らせる
- **THEN** マージ済みの PR を GitHub から引き直し、置き場所のブランチにはコミットを足さない

#### MODIFIED Requirements

##### Requirement: 正本の置き場所

システムは カード・判断・並び順の正本を、`main` の `.ai-board/config.yaml` の `store.kind` で選んだ 1 つの置き場所に置かなければならない (MUST)。`store.kind` を書かなければ `git` としなければならない (MUST)。

- `git`: 設定で指す git のリポジトリの 1 つのブランチの `.ai-board/` の下に、ファイル（`board.yaml`・`order.yaml`・`cards/<id>/card.md`・`cards/<id>/log/`）として置く。リモートとブランチは `store.remote` と `store.branch` で指し、書かなければ `origin` と `main` を使う。`AI_BOARD_STORE` があれば、そのパスの git リポジトリを置き場所のリモートとして使い、手元のファイル（`.ai-board/local/` に置くもの）もそのパスの隣の別のディレクトリに置く
- `artifact`: Artifact の DB に、文書（コレクションと ID で指す JSON）として置く。URL は `store.url` で指す。マージ済みの PR の控えとループの記録もここに置く

`ai-board store kind` は、選んだ置き場所の種類（`git` か `artifact`）を 1 行で出さなければならない (MUST)。
リポジトリ（カード・区切り線・PR の控え・ループの記録）は、置き場所の口（`DocumentStore`）だけを通して読み書きしなければならない (MUST)。置き場所の種類で、その上の usecase・検査・ステージの導出を変えては SHALL NOT。

###### Scenario: 既定は git

- **WHEN** `.ai-board/config.yaml` に `store.kind` が無い状態で `ai-board store kind` を走らせる
- **THEN** `git` を出す

###### Scenario: artifact で URL が無い

- **WHEN** `store.kind: artifact` で `store.url` が無い状態で `ai-board status` を走らせる
- **THEN** 置き場所が未設定であることと、設定の仕方を 1 行で伝えて 0 以外で終わる

###### Scenario: git で置き場所のリモートが無い

- **WHEN** `store.kind: git` で、`store.remote` の指すリモートがリポジトリに無い状態で `ai-board status` を走らせる
- **THEN** リモートが無いことと、設定の仕方を 1 行で伝えて 0 以外で終わる

###### Scenario: git で置き場所がまだ始まっていない

- **WHEN** `store.kind: git` で、置き場所のブランチに `.ai-board/board.yaml` が無い状態で `ai-board card list` を走らせる
- **THEN** `ai-board store init` を促して 0 以外で終わる

##### Requirement: 手元の写しを読む

システムは artifact の置き場所では、CLI の読み出しを、手元の写し（`.ai-board/store/mirror/`）から行わなければならない (MUST)。
写しは `ai-board store pull --from <dir>` で、`ArtifactData` の `out_dir` が書き出した形（`<collection>/<doc_id>.json`）のディレクトリから丸ごと入れ替えなければならない (MUST)。
`out_dir` がファイル名の `~` を `@` に置き換えて書いた名前（`<ID>@<連番>.json`）も、名前を書き換えずに読まなければならない (MUST)。
送る箱に送っていない書き込みが残っているときは、取り込みを拒まなければならない (MUST)（取り込むと、まだ送っていない書き込みの土台が変わるため）。
写しが無いときは、取り込みを促して 0 以外で終わらなければならない (MUST)。
git の置き場所では `store pull` を、使わないと伝えて 0 以外で終わらなければならない (MUST)。

###### Scenario: 取り込んで読む

- **WHEN** artifact の置き場所で、DB の文書を `out_dir` で書き出したディレクトリを `ai-board store pull --from` に渡し、続けて `ai-board card list` を走らせる
- **THEN** 書き出した文書のカードが並ぶ

###### Scenario: 送っていない書き込みがある

- **WHEN** artifact の置き場所で、送る箱が空でないときに `ai-board store pull` を走らせる
- **THEN** 送るか捨てるかを促して 0 以外で終わり、写しは変わらない

###### Scenario: git の置き場所で取り込もうとした

- **WHEN** `store.kind: git` で `ai-board store pull` を走らせる
- **THEN** git の置き場所では使わないと伝えて 0 以外で終わる

##### Requirement: 書き込みを送る箱に積む

システムは artifact の置き場所では、CLI の書き込みを、写しを直したうえで、新しい文書の作成として送る箱に積まなければならない (MUST)。
置き場所の文書を書き換えては SHALL NOT。文書を変えるときは同じ論理 ID の次の改訂（`<ID>~<6 桁の連番>`）を作り、消すときは消したことを表す改訂を作らなければならない (MUST)。読むときは論理 ID ごとに最新の改訂を使わなければならない (MUST)。
書く前の検査（判断を書けるか、ゲートの状態など）は、写しの最新のカードに対して行わなければならない (MUST)。
`ai-board store outbox --json` は、積んだ書き込みを `ArtifactData` の `batch` の `writes` にそのまま渡せる形（1 回 50 件まで）で出さなければならない (MUST)。
書き込みには `if_version` を付けない。既にある改訂と同じ ID を作る書き込みを含む束は、置き場所が丸ごと拒むので、それを書き込みのぶつかりとして扱わなければならない (MUST)。
`ai-board store ack --through <連番>` は送り終えた束（連番がそれ以下のもの）だけを送る箱から消し、`outbox` を読んだ後にほかのプロセスが積んだ束を残さなければならない (MUST)。`ai-board store discard` は送る箱を捨てて写しを積む前に戻さなければならない (MUST)。
git の置き場所では `store outbox` / `ack` / `discard` を、使わないと伝えて 0 以外で終わらなければならない (MUST)。

###### Scenario: 提出を積む

- **WHEN** artifact の置き場所で、写しを取り込んだ後に `ai-board card submit <id>` を走らせる
- **THEN** 写しのカードは計画レビューを待つ状態になり、送る箱に判断の文書 1 件の新規の書き込みが積まれる

###### Scenario: 改訂がぶつかる

- **WHEN** artifact の置き場所で、送る箱の書き込みを送ったが、その間に別の端末が同じカードの同じ改訂を先に作っていた
- **THEN** DB には何も書かれず、送る箱を捨てて取り込み直し、元のコマンドを頭から走らせ直すと、最新のカードに対して検査し直される

###### Scenario: git の置き場所で送る箱を読もうとした

- **WHEN** `store.kind: git` で `ai-board store outbox --json` を走らせる
- **THEN** git の置き場所では使わないと伝えて 0 以外で終わる

##### Requirement: データ用ブランチから移す

システムは artifact の置き場所では、データ用ブランチの clone を読み、カード・判断・並び順・区切り線を、新しい文書の書き込みとして送る箱に積む `ai-board store import --from <dir>` を提供しなければならない (MUST)。
マージ済みの PR の控えとループの記録は移しては SHALL NOT（控えは GitHub から引き直し、ループの記録は見るためのものだから）。
写しにカードが 1 枚でもあれば、拒まなければならない (MUST)（二重に移さないため）。
git の置き場所では、使わないと伝えて 0 以外で終わらなければならない (MUST)。

###### Scenario: 移す

- **WHEN** artifact の置き場所で、空の DB を取り込んだ写しで、データ用ブランチの clone を `--from` に渡して `ai-board store import` を走らせ、送って取り込み直す
- **THEN** `ai-board card list` の ID・タイトル・並び順・`## レビュー` が、移す前のデータ用ブランチの CLI の出力と一致する

##### Requirement: 形の版

システムは 置き場所の `board/meta`（git の置き場所では `.ai-board/board.yaml`）に形の版を持ち、自分と違う版の置き場所を読まずに止まらなければならない (MUST)。
版は 3 とし、置き場所の種類で変えては SHALL NOT（文書の形はどちらの置き場所でも同じため）。

###### Scenario: 版が違う

- **WHEN** 置き場所の `board/meta` の版が 3 でない
- **THEN** 読まずに、版が違うことを伝えて 0 以外で終わる

##### Requirement: 固定の seed ファイルから起票する

システムは `main` の `.ai-board/seed/*.md`（`card seed --from` が読む形）を、`ai-board store seed` で起票の書き込みとして書かなければならない (MUST)。artifact の置き場所では送る箱に積み、git の置き場所では置き場所のブランチへ push する。
既にある ID は飛ばし、`rank`・着手・`## レビュー` は書いては SHALL NOT。
起票は `.ai-board/seed/order.txt`（1 行 1 ID）に書いた順に、書いていない題材はその後にファイル名の順に行い、起票の時刻を前のカードより必ず後にしなければならない (MUST)（アイデアは `rank` が無ければ起票の時刻の順に並ぶので、`rank` を書かずにこの順で並べる）。
`order.txt` に題材の無い ID や同じ ID が 2 度あれば、1 枚も起票してはならない (SHALL NOT)。

###### Scenario: 空の置き場所に seed を入れる

- **WHEN** 空の DB を取り込んだ写しで `ai-board store seed` を走らせ、送る箱を送って取り込み直す
- **THEN** seed のカードが `order.txt` の順にアイデアの列に並ぶ

###### Scenario: 空の git の置き場所に seed を入れる

- **WHEN** `store.kind: git` で `ai-board store init` の後に `ai-board store seed` を走らせる
- **THEN** 置き場所のブランチに seed のカードの `card.md` を足すコミットが push され、`order.txt` の順にアイデアの列に並ぶ

### board-stages（`docs/specs/board-stages/spec.md`）

#### MODIFIED Requirements

##### Requirement: 計画レビューは計画の成果物の存在で立つ

システムは 計画の成果物があり、かつ plan ゲートが未提出か人の判断待ちのとき
`plan-review` を返さなければならない (MUST)。
plan ゲートが通過済み・差し戻し中・保留中のときは `plan-review` を返しては SHALL NOT。

計画の成果物とは、次のどれかである。

- open で Draft の PR。AI は計画をコミットした時点で Draft の PR を出す。計画ファイル（`.ai-board/cards/<id>/plan.md`）はそのブランチにあり、main にはマージまで入らないので、Draft の PR を計画の成果物として扱う
- GitHub が未設定のボードでは、カードのブランチの計画ファイル（`cards/<id>/plan.md`、無ければ今の置き方の `plans/<id>.md`）。PR が無いためである
- main の今の置き方の計画ファイル（`plans/<id>.md`）。artifact の置き場所で使っている最中のボードのための互換である

GitHub があるボードでは、カードのブランチの計画ファイルを読んでは SHALL NOT（Draft の PR を出す前のコミットの時点で計画レビューが立ち、`status` のたびに git を走らせるため）。
main の計画が `cards/<id>/plan.md` に変わったことで、「main に計画ファイルがあるだけで計画レビューが立つ」保険は、GitHub が未設定のボードのブランチの計画と、互換の `plans/<id>.md` だけになる。

plan ゲートのレビュー記録が 1 件も無い場合も `plan-review` を返さなければならない (MUST)。
成果物が存在する事実を正とし、記録の欠落によって人待ちを取りこぼさないためである。

###### Scenario: 今の置き方の計画が main にある

- **WHEN** main に `.ai-board/plans/<id>.md` があり、plan ゲートの記録が無い
- **THEN** ステージは `plan-review` になる（今の仕様の「計画が出た」を、この互換の場面に置き換える）

###### Scenario: 計画の Draft の PR が出た

- **WHEN** カードに open で Draft の PR が紐付き、plan ゲートの記録が無い
- **THEN** ステージは `plan-review` になる

###### Scenario: GitHub が未設定のボードで、計画がカードのブランチにだけある

- **WHEN** `config.yaml` に `github:` が無く、置き場所のブランチに計画ファイルは無いが、カードのブランチに `.ai-board/cards/<id>/plan.md` があり、plan ゲートの記録が提出である
- **THEN** ステージは `plan-review` になる

###### Scenario: AI が差し戻された計画を直しきれずに止まった

- **WHEN** カードに Draft の PR があり、plan ゲートの最新の記録が保留である
- **THEN** ステージは `planning` のままである（止まりは board-hold の仕様で示す）

#### ADDED Requirements

##### Requirement: PR 中とマージ済みは PR と main の計画で決まる

システムは PR が open で Draft でない（Ready の）とき `pr`、PR がマージされたか、main に `.ai-board/cards/<id>/plan.md`（または今の置き方の `plans/archive/<id>.md`）があるとき `merged` を返さなければならない (MUST)。
main の計画は、作業ツリーではなく git の参照から読まなければならない (MUST)。git の置き場所では fetch した置き場所の参照を、artifact の置き場所では手元の `main` の参照を読む。メインのチェックアウトがほかのブランチにいても、そのブランチの計画でマージ済みに見えてはならないためである。
計画の時刻は、その参照で計画ファイルを最後に変えたコミットの時刻としなければならない (MUST)。
open でも Draft の PR は `pr` を立てない。計画の成果物か、実装中の PR だからである。
計画はカードのブランチに載り、main にはマージでだけ入るので、main の計画をマージ済みの印に使う。
AI は実装と AI レビューを終えたら、動かした証拠を PR の本文に書き、計画の末尾に `## 締め` の節を足して PR を Ready にする。

###### Scenario: PR が Ready で出ている

- **WHEN** カードに紐付いた PR が open で Draft でない
- **THEN** ステージは `pr` になる

###### Scenario: PR が Draft のまま

- **WHEN** 計画が承認済みで、カードに紐付いた PR が open で Draft である
- **THEN** ステージは `pr` にならず、`impling` になる

###### Scenario: PR がマージされた

- **WHEN** カードに紐付いた PR がマージされている
- **THEN** ステージは `merged` になる

###### Scenario: 計画が main に入った

- **WHEN** main に `.ai-board/cards/<id>/plan.md` がある
- **THEN** ステージは `merged` になる

#### REMOVED Requirements

##### Requirement: PR 中とマージ済みは PR と archive で決まる

archive をやめ、main の計画でマージ済みを決めるため（「PR 中とマージ済みは PR と main の計画で決まる」に置き換える）。

### board-hold（`docs/specs/board-hold/spec.md`）

#### MODIFIED Requirements

##### Requirement: 止まりはステージとは別の軸で示す

システムは AI の列（`planning` / `impling`）にいて人の判断を待っているカードと、PR の状態を引けないカード（後述）を、止まりとして示さなければならない (MUST)。
止まりはステージとして扱っては SHALL NOT、保存しても SHALL NOT。ステージは「工程のどこにいるか」、
止まりは「その工程で誰を待っているか」を表し、実態から毎回導出する。

止まりは次のときに立つ。

- `impling` で、最新のレビュー記録より後に PR が Draft に戻された。
  比べる記録は中止を除いた全ゲートの最新で、AI の提出も含む。レビュー記録が 1 件も無いカードは、戻された時点で止まる。
  AI が締めの段で Ready にした PR を人が Draft に戻すと、カードは `impling` に落ち、計画には `## 締め` の節がある。
  止めないと AI ループは PR を Ready に戻してしまう
- `impling` で、GitHub が未設定のボードの締めの段が、カードのブランチの計画に `## 締め` の節を足した（今の置き方の計画では、ブランチで `plans/archive/<id>.md` へ移した）（ブランチのマージ待ち）。
  PR が無いので PR中 は立たず、止めないと AI ループは締めの手を繰り返す。人が main にブランチをマージして push すれば、計画が main に入ってマージ済みになり外れる。
  ブランチの `## 締め` はこの止まりにだけ使い、ステージの導出には使っては SHALL NOT
- `planning` で、plan ゲートが保留中である
- `planning` で、plan ゲートが判断待ちなのに、計画ファイルも Draft の PR も見えない。
  ただし PR の状態を引けていない（取得先に未接続、または初回の取得前）ときは、PR が無いのか分からないので立てては SHALL NOT

中止したカードには止まりを立てては SHALL NOT。終端に達しており、人の判断を待っていないためである。

止まりには、人が何をすればよいかを示す理由と、人を待ち始めた時刻を持たせなければならない (MUST)。
止まっているカードは、人の判断を待つカードと同じく判断待ちとして示さなければならない (MUST)。
AI ループの次の一手に、止まっているカードを選んでは SHALL NOT。後ろのカードは選べなければならない (MUST)。

人が承認 / 差し戻し / 中止を記録すれば、そのエントリが最新になって止まりは外れなければならない (MUST)。
ただし PR の状態を引けない止まり（次の要件）は除く。その止まりには判断を書けず、次に引ければ外れる。
止まりを解くための専用の記録を設けては SHALL NOT。

作成時から Draft の PR は、Draft に戻されたとはみなしては SHALL NOT。

###### Scenario: AI が計画の保留を書いて止まった

- **WHEN** `planning` のカードで plan ゲートの最新の記録が保留であり、後ろに `planning` のカードがある
- **THEN** 保留のカードは止まりとして判断待ちに示され、次の一手には後ろのカードが選ばれる

###### Scenario: Ready にした PR が Draft に戻された

- **WHEN** plan ゲートが承認済みで、その承認より後に PR が Draft に戻された
- **THEN** ステージは `impling` のまま止まりとして示され、AI ループは PR を Ready にし直す手を選ばない

###### Scenario: 計画レビューを飛ばすカードの PR が Draft に戻された

- **WHEN** plan ゲートをスキップすると宣言したカードが plan の提出によって `impling` にいて、その提出より後に PR が Draft に戻された
- **THEN** 止まりとして示され、AI ループはそのカードに手を選ばない

###### Scenario: Draft に戻された後に人が判断した

- **WHEN** PR が Draft に戻された後に、人が plan の差し戻し（計画から立て直させる）を記録した
- **THEN** 止まりは外れ、カードは `planning` に落ち、AI ループは差し戻された計画を直す手を選ぶ

###### Scenario: GitHub が未設定のボードで締めの段が終わった

- **WHEN** GitHub が未設定のボードで、plan ゲートが承認済みのカードのブランチの `cards/<id>/plan.md` に `## 締め` の節があり、置き場所のブランチには計画が無い
- **THEN** ステージは `impling` のまま、ブランチのマージを求める止まりとして示され、AI ループはそのカードに手を選ばない。出せる判断は 計画から立て直させる / 中止 である

###### Scenario: マージ待ちのブランチを人が main にマージした

- **WHEN** マージ待ちの止まりのカードのブランチを、人が main にマージして push し、置き場所のブランチに `cards/<id>/plan.md` が入った
- **THEN** 止まりは外れ、カードは `merged` になる

###### Scenario: 作成時から Draft の PR

- **WHEN** 計画が承認済みで、PR は作成時から Draft のままであり、一度も Draft に戻されていない
- **THEN** 止まりは立たず、AI ループはタスクを倒す手を選ぶ

### loop-activity（`docs/specs/loop-activity/spec.md`）

#### MODIFIED Requirements

##### Requirement: ループの 1 手ごとの記録を残す

システムは ループ（`/board-loop` を動かした本筋のセッション）が進めた 1 手ごとに、どのループが・どのカードに・どの手（と段）を・どの作業者（レビューの段で立てたサブエージェント。本筋のセッションが自分で進めた手は無し）で進め、
いつ始めていつ終えたか、結果を、1 件の記録として残さなければならない (MUST)。
artifact の置き場所では、記録はカードと同じ置き場所に置き、書くたびに送らなければならない (MUST)。クラウドのセッションが片付けられても残り、別の端末のボードからも見えるようにするためである。
git の置き場所では、記録はメインのチェックアウトの `.ai-board/local/`（git に載せない）に置き、置き場所のブランチに書いては SHALL NOT。1 手ごとに main へコミットが 2 つ増えるのを避けるためである。記録はその PC のボードからだけ見え、ほかの PC のループは見えない。
置き場所の形の版を上げては SHALL NOT（古い版の CLI がカードを読めなくなり、ループ自身が止まるため）。

記録はカードの属性として持っては SHALL NOT、ステージの導出・止まり・次の一手に使っては SHALL NOT。

記録を書くのはループ（本筋のセッション）だけで、書く口はカードを書けない形でなければならない (MUST)。
開始は、存在しないカードや、今の次の一手の語彙に無い手・段（廃止した手を含む）では拒まなければならない (MUST)。
同じループに終わっていない記録が残っていれば、開始はそれを「途切れた」で閉じてから新しい記録を作らなければならない (MUST)。
終了は、そのループの終わっていない記録を 1 度だけ埋め、終わっていない記録が無いとき・カードが食い違うときは拒まなければならない (MUST)。
終わった記録を書き換えては SHALL NOT。
読めない記録は読み飛ばし、ボード全体を止めては SHALL NOT。

記録を書けなくても、ループは手を進め続けなければならない (MUST)。記録は見るためのもので、本来の作業を止めないためである。

###### Scenario: 1 手を進めて終える

- **WHEN** ループが手の始まりに開始を書き、手を終えて終了を書いた
- **THEN** 記録が 1 件でき、カードの文書は変わらない。artifact の置き場所では開始と終了の 2 回の書き込みが送る箱を通って置き場所に届き、git の置き場所では `.ai-board/local/` の記録だけが変わって置き場所のブランチにはコミットが足されない

###### Scenario: 終了を書き損ねた

- **WHEN** 同じループが、終了を書かないまま次の手の開始を書いた
- **THEN** 前の記録は「途切れた」で閉じ、新しい記録だけが終わっていない記録になる

###### Scenario: 打ち間違い

- **WHEN** 存在しないカードの開始や、終わっていない記録の無い終了を書こうとした
- **THEN** 拒まれて何も書かれない

## 設計

### Decisions

- **置き場所の口を非同期の読み込みにする。** `DocumentStore.check()` を `Promise<Result<void, StoreError>>` にする。CLI は読む前に必ず 1 回 `await` し、今 `check()` を呼ばずに読んでいる `runLoop`（`cli-main.ts`）も呼ぶ。
  `MemoryDocumentStore`・`ArtifactMirrorStore`・契約テスト・呼び出し元（`cli-main.ts`・`card-cli.ts`・`store-cli.ts`）を同じ節で受け止める
- **`GitDocumentStore`（`src/infrastructure/git-document-store.ts`）**
  - `check()` で、手元のロックを取ってから `git fetch <remote> +refs/heads/<branch>:refs/ai-board/store` を 1 回走らせる。専用の参照に取るので、ワークツリーから同時に走らせても `FETCH_HEAD` や追跡ブランチを取り合わない
  - その参照の `.ai-board/board.yaml`・`.ai-board/order.yaml`・`.ai-board/cards/` だけを `git ls-tree` と `git cat-file --batch` で全部メモリに読む（`plans/` と `seed/` は読まない）。`card.md` の無いカードのディレクトリは読み飛ばす。`get` / `list` は同期の口のまま、このメモリから返す
  - コレクションとファイルの対応: `board/meta` ↔ `board.yaml`、`order/order` ↔ `order.yaml`、`cards/<id>` ↔ `cards/<id>/card.md`、`log/<cardId>.<名前>` ↔ `cards/<cardId>/log/<名前>.md`。
    カードと判断の行き来は `card-files.ts` の今の関数を使う。`board.yaml`（版 3 の `board/meta`）の読み書きは新しく作る（今の `ai-board-data.yaml` と版 2 の関数は使わない）
  - `snapshots` と `loop` のコレクションは手元の JSON に読み書きし、git に載せない（同じ口の中で振り分ける）。手元の場所は `.ai-board/local/`、`AI_BOARD_STORE` を指したときはそのパスの隣の `<パス>.local/` にする（試しの記録が本物に混ざらないように）
  - `transact` は手元のロックを取り、`op` の書き込みを集める。置き場所のファイルへの書き込みが 0 件なら、手元のファイルだけを書いて終える（fetch・コミット・push をしない）。
    1 件以上あれば、一時の index（`GIT_INDEX_FILE`）で `read-tree` → blob を足す → `write-tree` → `commit-tree -p <先頭>` でコミットを作り、`git push <remote> <commit>:refs/heads/<branch>` する。
    拒まれたら fetch し直して `op` を最初から走らせ直す（3 回まで）。コミットの題は `TransactLabel` から `chore(board): <label>` で作る
  - `store init` の置き場所がまだ無い（空のリポジトリ・ブランチが無い）ときは、親の無いコミットを作る
  - 置き場所のファイル以外（`plan.md` など）には書かない。`plan.md` を書こうとする口は無い
  - 外部コマンドは `cli-runner.ts` に閉じ、引数は配列で渡す。blob の中身を渡すため、`RunOptions` に標準入力（`input`）を足す。fetch と push は既定の 10 秒では足りないので 60 秒、`cat-file --batch` の出力の上限は 64MB にする
  - `pendingWrites()` は常に 0
- **main の計画の読み取り（`src/infrastructure/git-plan-tree.ts`）:** 参照を 1 つ受け取り、`git ls-tree` で `.ai-board/cards/*/plan.md` と、互換の `.ai-board/plans/*.md`・`.ai-board/plans/archive/*.md` を並べて中身を読む。
  時刻は `git log --format=... --name-only <参照> -- <それらのパス>` を 1 回走らせ、ファイルごとに最初に出たコミットの時刻を使う。参照は、git では `refs/ai-board/store`（`check()` が fetch した後）、artifact では `refs/heads/<store.branch>` とする
- **計画のリポジトリ:** `FsPlanRepository` を上の読み取りを使うものに替える。`cards/<id>/plan.md` と `plans/archive/<id>.md` はマージ済み（今の `archived`）、`plans/<id>.md` は今どおり計画の成果物とする。
  不正な ID は警告して読み飛ばす。`stage-resolver.ts` の規則は変えない（入力の作り方だけが変わる）
- **ブランチの計画:** `branch-plan.repository.ts` は `cards/<id>/plan.md` を読み、無ければ今の置き方の `plans/<id>.md` → `plans/archive/<id>.md` を読む。締め済み（今の `findClosed`）は、`cards/<id>/plan.md` に `## 締め` の節（コードブロックの外）があるか、今の置き方で archive だけがあるかで読む。
  `impl-step.ts` の「archive 済み」の段も同じ印で読む。決め打ちの `refs/remotes/origin/` は `store.remote` の追跡ブランチにする（`AI_BOARD_STORE` を指しても、カードのブランチはコードのリポジトリのリモートにある）
- **設定:** `store` に `kind`（`git` / `artifact`、既定 `git`）・`remote`（既定 `origin`）・`branch`（既定 `main`）を足し、`url` は artifact のときだけ読む。`AI_BOARD_STORE` は、git では試しに使う git リポジトリのパス（`git init --bare` したもの）を置き場所のリモートとして、artifact では今どおり写しのディレクトリとして指す
- **組み立て:** `composition.ts` が `kind` を見て `GitDocumentStore` か `ArtifactMirrorStore` を組み、計画の読み取りに渡す参照も決める。PR の控え・ループの記録のリポジトリは同じ口を使い、git の実装だけがそれを手元へ振り分ける
- **`ai-board store`** に `kind` と `check-branch <branch>` を足す。`check-branch` は置き場所の参照と `<branch>` の分岐点からの差分（`git diff --name-only`）で判定する。
  `init`（git では `board.yaml` と空の `order.yaml` を書く）と `seed` はどちらの置き場所でも動く。`pull` / `outbox` / `ack` / `discard` / `import` は artifact のときだけ動き、git では「git の置き場所では使わない」と伝えて 0 以外で終わる。
  今 `store-cli.ts` が依存している `ArtifactMirrorStore` の型（`initialize`・`ack` など）は、両方の実装が持つ `initialize` と、artifact だけの同期の操作に分ける
- **手順書の分岐:** `board-loop`・`board-decide`・`board-view` は最初に `ai-board store kind` を見て、`artifact` のときだけ `board-store` の取り込み・送り出しを挟む。分岐は手順書ごとに 1 か所にまとめる
- **締めの段:** `git mv` で archive へ移す代わりに、計画の末尾に `## 締め` の節（日付と、PR の本文の証拠への 1 行。GitHub が未設定のボードでは今の `## 動作確認の結果` などをこの節の下に書く）を足してコミットし、Ready にする。今の置き方の計画のカードは、今どおり archive へ移す
- **AI の push の決まり:** Bash からの `git push * main` の deny（`.claude/settings.json`）は残す。main へのコミットは `ai-board` の CLI の書き込みだけが作る。
  Claude が置き場所のファイルを直接書き換えないよう、`Edit` の deny に `.ai-board/cards/*/card.md`・`.ai-board/cards/*/log/**`・`.ai-board/order.yaml`・`.ai-board/board.yaml` を足す
- **ADR 0001 の保険:** main の計画が `cards/<id>/plan.md` に変わり、main にあるとマージ済みになる。「計画ファイルがあるだけで計画レビュー」の保険は、GitHub が未設定のボードのブランチの計画と、互換の `plans/<id>.md` だけに縮む。ADR 0001 と `CLAUDE.md` の不変条件を今の形に書き直す
- **始め方:** このリポジトリの置き場所のファイルは PR に入れない（カードのブランチは置き場所のファイルを変えない）。マージ後に人が `ai-board store init` と `ai-board store seed` を走らせ、main に最初のカードを入れる
- この計画自身も、最後の節で `.ai-board/plans/cards-as-markdown.md` から `.ai-board/cards/cards-as-markdown/plan.md` へ移す。マージで main に入り、このカードはマージ済みになる

### 仮定

- `## レビュー` を `card.md` の本文に入れず、今の形どおり `log/` の判断のファイルから組み立てる。並び順も今の `order.yaml` の 1 ファイルにする。ADR 0021 の「`## レビュー` は本文の中」「並び順はカードごとの `rank`」とは違うので、ADR を今の形に直す。
  根拠: `card-files.ts` と検査がこの形でできている。判断は 1 件 1 ファイルなので、3 人が同時に判断しても衝突しない。`order.yaml` の衝突は push のやり直しで、取り直した並び順の上に書き直せる
- 読み出しにも fetch を使う（毎回ネットワークに出る）。ADR 0017 の「1 回の実行で問い合わせは 1 回」に合わせ、`check()` の 1 回にまとめる
- artifact では main の計画を手元の `main` の参照で読む（fetch しない）。手元の `main` が古いとマージ済みに気づくのが遅れるが、GitHub があるボードでは PR がマージされたことでもマージ済みが立つ
- メインのチェックアウトが main 以外のブランチにいても、未コミットの変更があっても動く。作業ツリーに触らないため。手元の `main` は人が普段どおり pull して追いつく
- マージ済みの PR の控えは手元に置き、無ければ引き直す。`data-branch-import.ts` の頃から、控えは GitHub から引き直せるものとして扱ってきた
- 置き場所の種類をまたいで、使っている最中のボードを移す手順は作らない。アイデアのカードだけなら、今の `card export --to` と `card seed --from` で移せる
- 形の版は 3 のままにする。文書の形はどちらの置き場所でも同じで、上げると artifact の置き場所を使う古い CLI がカードを読めなくなる

### 退けた代案

- **artifact の置き場所を消して git に一本化する** — claude.ai を使える場で artifact の置き場所を使う人がいる（plan 差し戻し、2026-11-22）
- **置き場所の種類で計画の置き場所も分ける（artifact では今の `plans/` と `archive/`）** — 計画はどちらでも git のブランチに載るので、分けると段・止まり・手順書の分岐が倍になる。今の置き方は互換として読むだけにする（人に判断してほしいこと）
- **artifact では main の計画をメインのチェックアウトの作業ツリーから読む（今どおり）** — チェックアウトがほかのブランチにいると、そのブランチの `cards/<id>/plan.md` でマージ済みに見える
- **`check-branch` をコミットごとに見る** — main を取り込んだマージのコミットで誤って止まる
- **メインのチェックアウトで `.ai-board/` だけを commit・pull・push する** — メインのチェックアウトが main 以外のブランチにいたり、未コミットの変更があったりすると動けない。人の作業ツリーを CLI が書き換えることになる
- **置き場所専用のワークツリーを置く** — ADR 0020 でやめたデータのワークツリーと同じ手間が戻る
- **`log/` をやめて `## レビュー` を `card.md` の本文に書く（ADR 0021 の文言どおり）** — 2 人が同じカードに同時に判断すると、同じファイルの書き換えになって衝突する。検査を作り直すことになる
- **ループの記録も置き場所のブランチに載せる** — 1 手ごとに main のコミットが 2 つ増え、コードの履歴が読みにくくなる（人に判断してほしいこと）
- **`ai-board view` を CLI に足し、ブラウザで開くページを本体で出す** — ひな形と `render.mjs` を `src/` へ移すことになり、この計画が大きくなる。別のカードにする（人に判断してほしいこと）

### Risks / Trade-offs

- **main のコミットが増える。** 起票・提出・判断・ブランチの紐付け・PR 番号の書き戻しのたびに 1 コミット増える。題を `chore(board):` で揃え、`git log -- src` などで分けて読めるようにする
- **手でファイルを書き換えられる。** 人がエディタで `log/` に承認のファイルを置くことは止められない。Claude には `Edit` の deny、ブランチには `check-branch` で補うが、main への人の直接の push は止めない
- **ネットワークに出られないと読めない。** オフラインの利用は要らない（ADR 0020 の背景）ので、fetch に失敗したら止まる
- **互換の読み方が残る。** `plans/` と `archive/` を読むコードを、artifact のボードの今のカードがマージされるまで持ち続ける。外す時期は別に決める
- **push のやり直しで `op` を 2 度走らせる。** `op` は置き場所を読んで書き込みを決めるだけで、外へ出ない作りになっている（`transact` の約束）ので、走らせ直しても副作用は残らない

### Non-Goals

- 置き場所の種類をまたいで、判断のログや PR のあるカードまで含めて移す手順（人に判断してほしいこと）
- `ai-board view` の CLI（人に判断してほしいこと）
- pre-push の hook やブランチ保護など、git や GitHub の側で置き場所のファイルを守る仕組み（人に判断してほしいこと）
- `.ai-board/plans/archive/` の過去の計画を `cards/<id>/plan.md` へ移すこと。互換の読み方で読まれ続け、履歴の文書としてそのまま残す（人に判断してほしいこと）
- 古い改訂の片付けなど、Artifact の DB の置き場所に向けた課題

## 動作確認の手順

`S` はスクラッチパッドの下の作業用ディレクトリ、`WT` はこのカードのワークツリーである。

1. `git init --bare "$S/store.git"` の後に `AI_BOARD_STORE="$S/store.git" node "$WT/dist/cli.js" store init --root "$WT"` を走らせ、`git --git-dir "$S/store.git" ls-tree -r main` に `.ai-board/board.yaml` と `.ai-board/order.yaml` があることを見る
2. 1 の置き場所で `card create --title 試し --id trial` → `card list` を走らせ、`trial` が出て、bare のリポジトリに `.ai-board/cards/trial/card.md` を足すコミットが 1 つ増えることを見る
3. 1 の置き場所で `decide start trial` → `card submit trial --reason テスト` を走らせ、`cards/trial/log/` に着手と提出のファイルが 1 つずつ増えることを見る。メインのチェックアウトの `git status` が変わらないことも見る
4. 1 の bare リポジトリを別のディレクトリへ clone し、そこから `order.yaml` を変えるコミットを push してから、`decide move trial --after none --before <先頭のカード>` を走らせる。push のやり直しが起き、両方の変更が残ることを見る
5. bare のリポジトリに、計画だけを足すコミット（`.ai-board/cards/trial/plan.md`）を push し、`status --json` で `trial` のステージが `merged` になることを見る。メインのチェックアウトを別のブランチに切り替え、そのブランチに別のカードの `cards/<id>/plan.md` を置いても、そのカードがマージ済みにならないことも見る
6. `card.md` を書き換えたコミットを持つブランチで `store check-branch <branch>` を走らせ、0 以外で終わって `card.md` が並ぶことを見る。`plan.md` だけを変えたブランチ、置き場所のファイルを変えた main をマージで取り込んだだけのブランチでは 0 で終わることを見る
7. `.ai-board/local/` を消した状態で `status` を走らせ、置き場所のブランチにコミットが増えないことを見る（GitHub に届く環境でだけ。届かなければ `走らせていない`）。1〜6 の間、`AI_BOARD_STORE` の隣の `store.git.local/` にだけ手元のファイルができ、メインのチェックアウトの `.ai-board/local/` が変わらないことも見る
8. `.ai-board/config.yaml` に `store: { kind: artifact }` を書いた一時のチェックアウトで、`AI_BOARD_STORE` を写しのディレクトリに向けて `store init` → `store ack --through 999999` → `store seed` → `status --json` を走らせ、今と同じく seed のカードがアイデアに並ぶことを見る。`store kind` が `artifact` を出し、`store check-branch` も動くことを見る
9. 8 の一時のチェックアウトの `main` に `.ai-board/plans/<id>.md` と `.ai-board/plans/archive/<id2>.md` をコミットし、写しにその 2 枚のカードを入れて `status --json` を走らせ、`<id>` が `plan-review`、`<id2>` が `merged` になることを見る（互換）
10. `store.kind` を書かない設定で `store kind` が `git` を出し、`store outbox --json` が「git の置き場所では使わない」で 0 以外で終わることを見る
11. 人の手順: 3 人のうち 2 人が、それぞれの PC から同じカードに判断を書き、どちらの判断も `card show` の `## レビュー` に出ることを見る（AI は動かせない）

## タスク

### 1. 置き場所の口を非同期の読み込みにする

- [ ] `DocumentStore.check()` を `Promise<Result<void, StoreError>>` にし、`MemoryDocumentStore`・`ArtifactMirrorStore`・`document-store.contract.ts` を合わせる
- [ ] 呼び出し元（`cli-main.ts`・`card-cli.ts`・`store-cli.ts`）を `await` に直し、`runLoop` も読む前に `check()` を呼ぶ。テストを合わせる

### 2. git の置き場所

- [ ] `cli-runner.ts` の `RunOptions` に標準入力（`input`）を足し、テストする
- [ ] `src/infrastructure/git-document-store.ts` に `GitDocumentStore` を作る（専用の参照へ fetch して読む、`board.yaml` の読み書き、一時の index でコミットを作って push する、書き込みが置き場所に無ければ push しない、拒まれたらやり直す、空の置き場所の `init`、`snapshots` と `loop` は手元へ）
- [ ] `document-store.contract.ts` を `GitDocumentStore` に当てる（bare のリポジトリを置き場所にする）。push のやり直し、作業ツリーに触らないこと、手元だけの書き込みで push しないことのテストを足す

### 3. 置き場所の組み替え

- [ ] `config.ts`: `store.kind`（既定 `git`）・`store.remote`・`store.branch` を足し、`store.url` は artifact のときだけ読む。`AI_BOARD_STORE` を種類ごとに読み、git では手元の場所を `<パス>.local/` にする。`.ai-board/config.yaml` の説明を直す
- [ ] `src/board/composition.ts`・`src/cards/composition.ts`・`cli-main.ts` を `kind` で `GitDocumentStore` か `ArtifactMirrorStore` に組み分ける。git のときは PR の控えのキャッシュとロックを手元の場所に置く
- [ ] `store-cli.ts` に `kind` と `check-branch` を足し、`init` / `seed` を両方の置き場所で動かす。依存の型を、両方の `initialize` と artifact だけの操作に分ける。`pull` / `outbox` / `ack` / `discard` / `import` は git のとき断る。`store-messages.ts` にエラー種と変換を足す（リモートが無い・fetch や push に失敗した・やり直しが尽きた・git の置き場所では使わない・ブランチが置き場所のファイルを変えた）
- [ ] `.gitignore` に `/.ai-board/local/` を足す（`/.ai-board/store/` は artifact の写しのため残す）
- [ ] 仕様の差分を `docs/specs/board-store/spec.md` と `docs/specs/loop-activity/spec.md` に写す

### 4. 計画の置き場所

- [ ] `src/infrastructure/git-plan-tree.ts` に、参照から `cards/*/plan.md` と互換の `plans/*.md`・`plans/archive/*.md` を読み、時刻をコミットから取る読み取りを作る
- [ ] `plan.repository.ts` をその読み取りの上に替え、`composition.ts` で種類ごとの参照を渡す。`get-board.query.ts`（`archivedAt` など）・`next-action.ts`・`board-sections.ts`・`src/cards/models/card.ts` の計画の場所と archive の扱いを合わせる
- [ ] `branch-plan.repository.ts`・`impl-step.ts`・`branch-plan-target.ts` を `cards/<id>/plan.md` と `## 締め` の節で読み、今の置き方にも落ちるものに替える。決め打ちの `origin` を `store.remote` にする
- [ ] `stage-resolver.ts`・`plan-state.ts`・`board-card.ts` などの docstring の「archive」を今の形に直す（規則は変えない）
- [ ] 仕様の差分を `docs/specs/board-stages/spec.md` と `docs/specs/board-hold/spec.md` に写す

### 5. 手順書

- [ ] `board-loop`（`SKILL.md`・`plan.md`・`implement.md`・`fix-pr.md`・`rules.md`）・`board-decide`・`.claude/agents/board-reviewer.md` の取り込み・送り出しを、`store kind` が `artifact` のときだけ行う分岐にまとめる。`board-store` のスキルに「artifact の置き場所のときだけ使う」と書く。
  計画の場所を `cards/<id>/plan.md`（今の置き方の計画のカードは `plans/<id>.md` のまま）に、締めの段を `## 締め` の節に、「動かして確かめるとき」に git（bare のリポジトリ）と artifact（写しのディレクトリ）の両方の手順を書く。push の前に `store check-branch` を走らせる手順を足す
- [ ] `board-view` のスキルを、artifact では今どおり Artifact で公開し、git では `.ai-board/local/board.html` に書き出してパスを伝える形にする
- [ ] `.claude/skills/adr/SKILL.md` の計画の archive の参照を今の形に直す
- [ ] `.claude/settings.json` の `ArtifactData` の hook は残し、`Edit` の deny に git の置き場所のファイルを足す。`claude-settings.test.ts` を直す

### 6. ドキュメント

- [ ] `CLAUDE.md`・`README.md`・`docs/reference.md`・`docs/verification.md`・`REVIEW.md` を 2 つの置き場所に合わせる（タスクの置き場所の節、置き場所の選び方と始め方、書き込み境界の表、計画ファイルの場所、不変条件の「計画ファイルが存在するだけで計画レビュー」を今の保険の範囲に）
- [ ] ADR: 0021 を「採用」にして今の形（`store.kind` で選び既定は git、`log/`・`order.yaml`、互換の読み方）に直す。0001 の保険の範囲、0004・0005 の archive、0014・0019・0020 を今の形に書き直し、一覧を直す
- [ ] この計画を `.ai-board/cards/cards-as-markdown/plan.md` へ移し、`.ai-board/plans/` に残る過去の計画（`archive/`）は触らない

## 探索メモとの対応

| #   | 探索メモ                                                                         | 反映した先                                 | 反映しなかった理由 |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------ | ------------------ |
| 1   | 「GitHub Issues・SQLite・ローカルの MCP サーバが HTML を返す案と比べて、この案に決めた」 | 提案 / Why、ADR 0021 の退けた案（タスク 5） |                    |
| 2   | 「前提: main に直接 push できる」                                                | 人に判断してほしいこと                     |                    |
| 3   | 人と決めた（2026-11-22）: 計画は同じディレクトリの `plan.md`、main にあればマージ済み、仕様は差分を書き `docs/specs/` を書き続ける | What Changes、仕様の差分、Decisions        |                    |
| 4   | 人と決めた（2026-11-22）: ボードの置き場所が未用意なので、カードは seed のファイルとして起票し、着手はチャットの指示で代える | Decisions の「始め方」                      |                    |
| 5   | plan 差し戻し（2026-11-22）: 「モード使う人はいる。デフォルトは git」         | Why、What Changes、仕様の差分（board-store・board-stages・loop-activity）、Decisions、退けた代案、タスク 2・4・5 |                    |
| 6   | 人と決めた（2026-11-22）: 計画レビュー（サブエージェントに読ませた指摘）への回答「既定でいい、直して再提出して」 | Decisions（口の非同期化・計画の読み取り・互換・手元の場所・push しない場合・check-branch）、仕様の差分、タスク 1〜6、人に判断してほしいこと |                    |

## 人に判断してほしいこと

- main に直接 push できること（ブランチ保護で PR 必須になっていない、3 人とも push 権限がある）を前提にしてよいか。既定: 前提にする
- git の置き場所では、ループの記録を各 PC の `.ai-board/local/` に置き、共有しない。ほかの人のループが今どのカードを触っているかは見えなくなる（artifact では今どおり共有される）。既定: 共有しない
- git の置き場所でブラウザで見る出口は、`board-view` のスキルが `.ai-board/local/board.html` に書き出す形までにし、`ai-board view` の CLI は別のカードにする。既定: 別のカード
- 置き場所の種類をまたいで、使っている最中のボード（判断のログ・PR のあるカード）を移す手順は作らない。アイデアのカードだけを `card export` / `card seed` で移せる。既定: 作らない
- pre-push の hook やブランチ保護は入れず、置き場所のファイルを守るのは Claude の `Edit` の deny と `store check-branch` までにする。既定: 入れない
- `.ai-board/plans/archive/` の過去の計画は移さずに残す。既定: 残す
- ADR 0021 と違い、`## レビュー` は `log/` の判断のファイルから組み立て、並び順は `order.yaml` の 1 ファイルにする（`### 仮定` の 1 つ目）。既定: 今のファイルの形を使う
- ADR 0001 の「計画ファイルがあるだけで計画レビュー」の保険が、GitHub が未設定のボードのブランチの計画と互換の `plans/<id>.md` だけに縮むことを受け入れるか。既定: 受け入れ、ADR 0001 と `CLAUDE.md` の不変条件を書き直す
  - → 回答（2026-11-22、チャット）: 既定でいい、直して再提出して
- artifact の置き場所で使っている最中のボードのカードの扱い。既定: 今の置き方（`plans/<id>.md`・`plans/archive/<id>.md`）も読み続ける互換を残す
  - → 回答（2026-11-22、チャット）: 既定でいい、直して再提出して
- 計画の置き場所は置き場所の種類で分けず、どちらも `cards/<id>/plan.md` にする（今の置き方は互換として読むだけ）。既定: 分けない
