# board-store Specification

## Purpose

カードの正本を置く場所と、CLI がそれを読み書きする流れを定める。置き場所は差し替えられる 1 つの口に閉じる。

## Requirements

### Requirement: 正本の置き場所

システムは カード・判断・並び順・マージ済みの PR の控え・ループの記録の正本を、設定で指す 1 つの置き場所に、文書（コレクションと ID で指す JSON）として置かなければならない (MUST)。
置き場所の既定は Artifact の DB とし、URL は `main` の `.ai-board/config.yaml` の `store.url` で指さなければならない (MUST)。
git のブランチに正本を置いては SHALL NOT。
リポジトリ（カード・区切り線・PR の控え・ループの記録）は、置き場所の口（`DocumentStore`）だけを通して読み書きしなければならない (MUST)。

#### Scenario: 設定に置き場所が無い

- **WHEN** `.ai-board/config.yaml` に `store.url` が無い状態で `ai-board status` を走らせる
- **THEN** 置き場所が未設定であることと、設定の仕方を 1 行で伝えて 0 以外で終わる

### Requirement: 手元の写しを読む

システムは CLI の読み出しを、手元の写し（`.ai-board/store/mirror/`）から行わなければならない (MUST)。
写しは `ai-board store pull --from <dir>` で、`ArtifactData` の `out_dir` が書き出した形（`<collection>/<doc_id>.json`）のディレクトリから丸ごと入れ替えなければならない (MUST)。
送る箱に送っていない書き込みが残っているときは、取り込みを拒まなければならない (MUST)（取り込むと、まだ送っていない書き込みの土台が変わるため）。
写しが無いときは、取り込みを促して 0 以外で終わらなければならない (MUST)。

#### Scenario: 取り込んで読む

- **WHEN** DB の文書を `out_dir` で書き出したディレクトリを `ai-board store pull --from` に渡し、続けて `ai-board card list` を走らせる
- **THEN** 書き出した文書のカードが並ぶ

#### Scenario: 送っていない書き込みがある

- **WHEN** 送る箱が空でないときに `ai-board store pull` を走らせる
- **THEN** 送るか捨てるかを促して 0 以外で終わり、写しは変わらない

### Requirement: 書き込みを送る箱に積む

システムは CLI の書き込みを、写しを直したうえで、新しい文書の作成として送る箱に積まなければならない (MUST)。
置き場所の文書を書き換えては SHALL NOT。文書を変えるときは同じ論理 ID の次の改訂（`<ID>~<6 桁の連番>`）を作り、消すときは消したことを表す改訂を作らなければならない (MUST)。読むときは論理 ID ごとに最新の改訂を使わなければならない (MUST)。
書く前の検査（判断を書けるか、ゲートの状態など）は、写しの最新のカードに対して行わなければならない (MUST)。
`ai-board store outbox --json` は、積んだ書き込みを `ArtifactData` の `batch` の `writes` にそのまま渡せる形（1 回 50 件まで）で出さなければならない (MUST)。
書き込みには `if_version` を付けない。既にある改訂と同じ ID を作る書き込みを含む束は、置き場所が丸ごと拒むので、それを書き込みのぶつかりとして扱わなければならない (MUST)。
`ai-board store ack` は送る箱を空にし、`ai-board store discard` は送る箱を捨てて写しを積む前に戻さなければならない (MUST)。

#### Scenario: 提出を積む

- **WHEN** 写しを取り込んだ後に `ai-board card submit <id>` を走らせる
- **THEN** 写しのカードは計画レビューを待つ状態になり、送る箱に判断の文書 1 件の新規の書き込みが積まれる

#### Scenario: 改訂がぶつかる

- **WHEN** 送る箱の書き込みを送ったが、その間に別の端末が同じカードの同じ改訂を先に作っていた
- **THEN** DB には何も書かれず、送る箱を捨てて取り込み直し、元のコマンドを頭から走らせ直すと、最新のカードに対して検査し直される

### Requirement: 形の版

システムは 置き場所の `board/meta` の文書に形の版を持ち、自分と違う版の写しを読まずに止まらなければならない (MUST)。
この計画で版を 3 とする。

#### Scenario: 版が違う

- **WHEN** 写しの `board/meta` の版が 3 でない
- **THEN** 読まずに、版が違うことを伝えて 0 以外で終わる

### Requirement: 固定の seed ファイルから起票する

システムは `main` の `.ai-board/seed/*.md`（`card seed --from` が読む形）を、`ai-board store seed` で起票の書き込みとして送る箱に積まなければならない (MUST)。
既にある ID は飛ばし、`rank`・着手・`## レビュー` は書いては SHALL NOT。

#### Scenario: 空の置き場所に seed を入れる

- **WHEN** 空の DB を取り込んだ写しで `ai-board store seed` を走らせ、送る箱を送って取り込み直す
- **THEN** seed のカードがアイデアの列に並ぶ

### Requirement: データ用ブランチから移す

システムは データ用ブランチの clone を読み、カード・判断・並び順・区切り線を、新しい文書の書き込みとして送る箱に積む `ai-board store import --from <dir>` を提供しなければならない (MUST)。
マージ済みの PR の控えとループの記録は移しては SHALL NOT（控えは GitHub から引き直し、ループの記録は見るためのものだから）。
写しにカードが 1 枚でもあれば、拒まなければならない (MUST)（二重に移さないため）。

#### Scenario: 移す

- **WHEN** 空の DB を取り込んだ写しで、データ用ブランチの clone を `--from` に渡して `ai-board store import` を走らせ、送って取り込み直す
- **THEN** `ai-board card list` の ID・タイトル・並び順・`## レビュー` が、移す前のデータ用ブランチの CLI の出力と一致する
