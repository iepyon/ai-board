# 0008. GitLab 連携を廃止し、レビュー要求の取得先を GitHub だけにする

- 状態: 採用
- 日付: 2026-09-26（PR #11 と #12 のマージ）
- 置き換え元: なし
- 置き換え先: なし

## 状況

ai-board は GitLab の MR からステージ（当時の AI-PR 系の列）を導出する形で始まった。
接続先の GitLab が無かったので、`gitlab-docker` の計画でローカルの GitLab を Docker Compose で立て、ボードが実物の API を読むところまでを通した。
その先の `gitlab-mr-loop`（ai-board 自身の開発を GitLab の MR で回す）や `jenkins-ci` は、カードのまま着手されていなかった。

その後、ai-board 自身を GitHub（`iepyon/ai-board`）で公開し、開発の主線も GitHub へ移した。
`github-pr-provider` では、GitLab を GitHub に置き換えるのではなく取得先をもう 1 つ選べるようにすると決め、
`.ai-board/config.yaml` の `gitlab:` と `github:` を排他選択にし、ローカル GitLab は検証環境として残した。
カードの `mr` の番号がどちらの取得先のものかは、`forge` 列で対にして記録していた。

廃止の当日の朝には、`gitlab-mr-loop` と `jenkins-ci` を含む 11 枚のカードを「重複・陳腐化した」として削除している（`d151075`）。
GitLab 連携そのものを廃止する理由は、コミットにも PR の本文にも書かれていない。

## 決定

レビュー要求の取得先を GitHub の Pull Request だけにし、GitLab 連携を削除する。

- glab のクライアント、`gitlab:` の設定と「両方書いたらエラー」の検査、ローカル GitLab の `compose.yaml` / `.env.example` を削除する。
- 取得先の種別を `github` だけにする。
- **GitLab の番号で別の PR を引かない。** GitLab の MR !1 と GitHub の PR #1 は別物なので、`forge: gitlab` のカードの `mr` を消し、`branch` から PR を解決し直させる。
- 取得先が 1 つになったので、`mr` の出どころを記録するカードの `forge` 列を削除する。

## 検討した代案

- **カードの `forge` 列を残す** — PR #11 では、列ごと消すと CLI の出力や取り込みへの影響が広がるとして値を `github` だけにして残した。
  同じ日の PR #12 で、番号の出どころを記録する必要が無くなったとして列を落とした。

GitLab を残すかどうかについての検討の記録は無い。

## 結果

- 認証を委ねる CLI は `gh` だけになった（認証の扱いは [0005](0005-delegate-auth-to-cli.md)）。
- `ForgePoller` は「`mr` があれば番号で、無ければ `branch` から解決して書き戻す」だけの形になった。
- 移行のために DB のマイグレーション v2 / v3 と、取り込みで `forge: gitlab` の番号を捨てる処理が入った。
- `/api/board` の接続状態 `forge`、`MrState.forge`、`ForgeClient` / `ForgePoller` の名前はカードの列とは別物として残した。
- `.gitignore` の `.env` と `/gitlab-backup/` は、手元に secrets を含むファイルが残り得るとして残した。

## 根拠

- 計画: `.ai-board/plans/archive/gitlab-docker.md`
- 計画: `.ai-board/plans/archive/github-pr-provider.md`（取得先の排他選択とローカル GitLab を残す判断）
- コミット: `3ec58e4` feat: GitLab 連携を廃止し、レビュー要求の取得先を GitHub だけにする
- コミット: `c4dcd59` refactor: カードの forge 列を削除する
- コミット: `d151075` chore: 重複・陳腐化したカードを削除する（`gitlab-mr-loop` / `jenkins-ci` のカード）
- PR: #11, #12
