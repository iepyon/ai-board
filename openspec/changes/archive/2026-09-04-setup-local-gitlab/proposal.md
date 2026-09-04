## Why

ボードの 7 列のうち AI-PR と AI-PR 修正済みの 2 列は、GitLab の MR 状態からしか導出できない。
接続先の GitLab が存在しないため、この 2 列は起動以来一度も実データで埋まったことがなく、
`resolveStage` のルール 2 と 3、および `GitLabPoller` の挙動が実物に対して検証されていない。

ai-board 側の実装は揃っている。`loadConfig()` は設定とトークンが揃えば連携を有効化し、
`HttpGitLabClient` は GitLab REST API v4 に 4 本の GET を投げるだけで、webhook も
GitLab からホストへの到達性も要求しない。欠けているのは接続先そのものである。

ローカルに GitLab を Docker Compose で立て、ボードが実物の API を読んで
AI-PR 列が埋まるところまでを通す。ここで確立する compose・認証情報・疎通確認の手順は、
後続の `gitlab-mr-loop`（ai-board 自身の開発を MR で回す）がそのまま土台にする。

## What Changes

- リポジトリ直下に `compose.yaml` を追加し、`gitlab/gitlab-ce` を単一サービスとして定義する
- `.env.example` を追加し、root パスワードを `.env` 経由で注入する形にする
- `.gitignore` に `.env` を追加する。現在この行が無く、パスワードを誤ってコミットしうる
- `.ai-board/config.yaml` を新規作成し `gitlab.url` と `gitlab.projectId` を設定する。
  このファイルは現在存在せず、そのため連携は `disabled` のまま起動している
- 疎通確認を再実行可能なコマンド列として README に記載する
- GitLab 側に検証用のプロジェクトと MR を 1 本用意する。作成は GitLab API のみで行い、
  ローカルからの push は行わない

スコープ外:

- ai-board リポジトリを GitLab へ push すること、`git remote` の設定、MR の実運用
  → `gitlab-mr-loop` カードに分離済み
- GitLab 以外のホスティング（Gitea / Forgejo）への対応。`HttpGitLabClient` は
  GitLab REST API v4 決め打ちで API が非互換のため、クライアントにアダプタ層を足す別の change になる
- 本番相当の可用性・バックアップ・HTTPS 終端

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

なし。

この change が追加するのは `compose.yaml`・`.env.example`・`.ai-board/config.yaml`・
`.gitignore` の 1 行・README の節だけで、`src/` には一切触れない。

「設定とトークンが揃ったときに GitLab 連携を有効化し、MR 状態から AI-PR 系のステージを
導出する」という振る舞いは既に実装され、`config.test.ts` と `stage-resolver.test.ts` で
検証済みである。この change はその振る舞いに設定値を与えるだけで、システムが満たすべき
要件を変えない。よって `.openspec.yaml` に `skip_specs: true` を設定する。
検証を通すためだけの要件は書かない。

## Impact

- **新規ファイル**: `compose.yaml`, `.env.example`, `.ai-board/config.yaml`
- **変更ファイル**: `.gitignore`, `README.md`
- **ソースコード**: 変更なし。既存テスト 145 件は影響を受けない
- **既存の挙動**: `loadConfig()` は `gitlab` セクションとトークンの両方が揃って初めて
  連携を有効化する（`config.test.ts` の「両方そろって初めて GitLab を有効にする」）。
  トークンを設定ファイルに書いても読まれないことも同テストが保証している。
  よって設定ファイルを追加しても、トークン未設定の環境では従来どおり `disabled` のまま動く
- **新規の外部依存**: Docker および Docker Compose。`gitlab/gitlab-ce` は amd64 / arm64 の
  両イメージを持つため、Apple Silicon でもエミュレーションは発生しない
- **運用上の影響**: GitLab 停止中はボードの接続状態が `error` になり AI-PR 系の列は
  キャッシュのみとなる。ボード自体は落ちない
