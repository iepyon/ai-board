## Why

ボードの AI-PR / AI-PR 修正済みの 2 列は GitLab の MR 状態から導出しているが、接続先の GitLab が
存在しないため常に空のまま検証できない。ai-board 側の実装（`HttpGitLabClient` / `GitLabPoller`）は
スタブで検証済みで、欠けているのは実物の GitLab だけである。

ローカルに GitLab を Docker Compose で立て、ボードが実際の GitLab API を読めるところまでを通す。
そこで確立した compose と認証情報は、後続の `gitlab-mr-loop`（ai-board 自身の開発を MR で回す）が
そのまま再利用する土台になる。

## What Changes

- リポジトリ直下に `compose.yaml` を追加し、`gitlab/gitlab-ce` を単一サービスとして定義する
- root パスワードを `.env` から注入する。`.env.example` を雛形としてコミットし、`.env` 本体は追跡しない
- `.gitignore` に `.env` を追加する（現状 `.env` 行が無く、パスワードを誤ってコミットする穴がある）
- `.ai-board/config.yaml` を追加し、`gitlab.url` と `gitlab.projectId` を設定する
  （このファイルは現在存在せず、そのため GitLab 連携は無効状態のまま）
- 疎通確認をコマンド列として README に記載する。手順書ではなく再実行可能な形にする
- omnibus 設定で不要コンポーネント（prometheus / grafana / registry）を無効化し、常駐メモリを削る

明示的にスコープ外とするもの:

- ai-board リポジトリを GitLab へ push すること、および MR を実際に運用すること → `gitlab-mr-loop`
- GitLab 以外のホスティング（Gitea / Forgejo）への対応。`HttpGitLabClient` は GitLab REST API v4
  決め打ちで API 非互換のため、クライアントのアダプタ層という別の change になる

## Capabilities

### New Capabilities

なし。この change は開発環境の構成とドキュメントのみを追加し、ai-board の振る舞いを変えない。

### Modified Capabilities

なし。`openspec/specs/` は空であり、変更すべき既存の要件も存在しない。

ソースコードに一切手を入れず、追加するのは `compose.yaml`・`.env.example`・`.ai-board/config.yaml`・
`.gitignore` の 1 行・README の節のみであるため、`.openspec.yaml` に `skip_specs: true` を設定する。
検証を通すためだけの要件は書かない。

## Impact

- **新規ファイル**: `compose.yaml`, `.env.example`, `.ai-board/config.yaml`
- **変更ファイル**: `.gitignore`, `README.md`
- **ソースコード**: 変更なし
- **既存の挙動**: `loadConfig()` は `gitlab` セクションとトークンの両方が揃って初めて連携を有効化する。
  片方でも欠ければ従来どおり連携が無効になるだけで、この change 以前の動作は保たれる
- **前提**: Docker と Docker Compose が利用できること。`gitlab/gitlab-ce` は amd64 / arm64 の
  両方のイメージを持つため、Apple Silicon でもエミュレーションは発生しない
- **運用上の注意**: GitLab を停止している間、ボードの接続状態は `error` を表示し AI-PR 系の列は
  キャッシュのみとなる。ボード自体は落ちない
