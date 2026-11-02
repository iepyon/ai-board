# 0005. GitHub（当時は GitLab も）の認証はログイン済みの CLI に委ね、アクセストークンを扱わない

- 状態: 採用（一部を [0008](0008-github-only.md) が置き換え）
- 日付: 2026-09-21
- 置き換え元: なし
- 置き換え先: [0008](0008-github-only.md)（一部）

## 状況

最初のコミット `0e3dd81` から、ai-board は GitLab の REST v4 をカード単位で `fetch` で問い合わせていた。
認証には環境変数 `AI_BOARD_GITLAB_TOKEN` の Personal Access Token を使い、設定に取得先かトークンが欠ければ連携を無効にしていた。
Node は `.env` を自力で読まないため、`803d674` で `dev` / `start` に `--env-file-if-exists=.env` を付けてトークンを渡すようにした。

その後 ai-board 自身を GitHub で公開し、開発の主線もそちらへ移した。レビュー要求はローカル GitLab からしか取れず、
GitHub の PR で回すと `pr` と `merged` の 2 段が実態を反映しなくなっていた。
github-pr-provider の計画は GitHub の PR を取得先に足すのにあわせて、認証をやめることにした。
ai-board はローカル専用ツールで、利用者の手元には `gh` / `glab` がすでにログイン済みで存在する。

## 決定

- **ai-board はアクセストークンを受け取らない・保持しない・記録しない。**
- **取得先への問い合わせは `gh api` / `glab api` をサブプロセスとして実行し、stdout の JSON を読む。** 認証は CLI のログイン状態に委ねる。
- `AI_BOARD_GITLAB_TOKEN` と、それを渡すための `--env-file-if-exists` を廃止する。有効化の条件は「取得先が設定に書かれている」の一条件にする。
- CLI が無い・未ログインなら連携を無効にし、理由を接続状態に出す。ボードは落とさない。接続の可否は起動時に 1 度だけ `auth status` で判定する。
- GitLab のホストは設定の `url` から取り出し、`glab` の既定ホストに頼らず環境変数 `GITLAB_HOST` で渡す。

## 検討した代案

- **`gh auth token` でトークンを取り出し、従来どおり `fetch` で叩く** — `glab` にはトークンを出力するサブコマンドが無く、
  GitLab 側で同じ形にできない。取得先ごとに認証の入手経路が変わる。トークンを ai-board のメモリに載せる時点で、
  「トークンを扱うのをやめる」が達成されない。
- **従来どおり環境変数のトークンを使い続ける** — 利用者が Personal Access Token を発行・保管・失効管理する必要が残る。
  ローカル専用ツールのために手作業の資格情報管理を強いる合理性が無い。
- **接続の可否を毎回のポーリングで確かめる** — ログイン状態が変わるのは稀で、30 秒ごとにプロセスを 1 つ余計に起動する価値が無い。
- **GitLab のホストを `--hostname` で渡す** — このフラグはポート付きのホストを受け付けず、検証用の `localhost:8929` を指定できない。

## 結果

- 利用者は資格情報を ai-board に渡さなくてよくなり、`.env` は compose 用の値だけになった。
- 連携を使うには `gh`（または `glab`）がインストールされ、ログイン済みであることが実行時の前提になった。
  ログインし直した場合は ai-board の再起動で反映される。
- サブプロセス起動の分だけ問い合わせが遅くなる（実測で `gh api` 1 回約 0.4 秒、ほぼネットワーク待ち）。
- 「CLI をサブプロセス起動せずディレクトリを直接読む」という openspec の扱いとは方針が逆になった。
  計画は「読めるものは読み、持ちたくないものは委ねる」とした。
- CLI の実行は shell を介さず引数を配列で渡す決まりを同時に入れた（[0006](0006-cli-runner-no-shell.md)）。
- **GitHub のアクセストークンは扱わない**は CLAUDE.md の不変条件になった。
- GitLab 連携は後に廃止し、`glab` と `GITLAB_HOST` の部分は不要になった（[0008](0008-github-only.md)）。
  GitHub の認証を `gh` に委ねる判断は残っている。

## 根拠

- 計画: `.ai-board/plans/archive/github-pr-provider.md`（Why・What Changes・Decisions「認証は CLI へ委ね、問い合わせは `gh api` / `glab api` の実行にする」
  「接続の可否は起動時に 1 度だけ判定する」「GitLab のホストは設定の `url` から解決し、環境変数 `GITLAB_HOST` で渡す」・Risks・Migration Plan）
- コミット: `803d674` chore: dev と start で .env を読んでトークンを渡す
- コミット: `cf402fc` feat: GitHub の PR をボードに乗せ、認証を gh / glab に委ねる
- コミット: `7dcd394` docs: github-pr-provider の plan ゲートに承認を記録する
- `CLAUDE.md`「設計の不変条件」
