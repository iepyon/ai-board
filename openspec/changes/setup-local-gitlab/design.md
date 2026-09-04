## Context

動機は proposal.md - Why を参照。設計を左右する現状の制約だけを挙げる。

- `loadConfig()`（`src/shared/config.ts`）は `.ai-board/config.yaml` の `gitlab` セクションと
  環境変数 `AI_BOARD_GITLAB_TOKEN` の両方が揃ったときだけ連携を有効化する。片方でも欠ければ
  例外にはならず、連携が無効になるだけ。したがって設定の投入は段階的に進められる
- `GitLabConfigSchema` の `projectId` は `number | string` を受ける
- `HttpGitLabClient` は `${url}/api/v4/projects/${projectId}` に `PRIVATE-TOKEN` ヘッダで
  4 本の GET を投げるだけ。webhook もコールバックも使わないため、GitLab からホストへの
  到達性は不要で、ホスト → GitLab の一方向で足りる
- 開発機は arm64 の macOS。Docker Desktop のバインドマウントは低速で、`gitlab/gitlab-ce` は
  amd64 / arm64 の両方のイメージを持つ

## Goals / Non-Goals

**Goals:**

- `docker compose up -d` 一発で GitLab が起動し、ボードが実データを読める状態になること
- 疎通確認が再実行可能なコマンド列であること。Web UI のクリック手順に依存しない
- 認証情報がリポジトリに入らないこと
- 後続の `gitlab-mr-loop` が compose と PAT 発行手順をそのまま再利用できること

**Non-Goals:**

- 本番相当の可用性・バックアップ・HTTPS 終端。ローカル検証専用とする
- GitLab の常時起動を前提とした設計。停止中もボードが落ちないことは既存実装が保証している

## Decisions

### 1. `compose.yaml` はリポジトリ直下に置き、コミットする

`gitlab-mr-loop` で ai-board 自身の MR をこの GitLab に流す以上、compose は使い捨てではなく
恒久的なインフラ定義になる。よって `.gitignore` には入れない。

直下に置くのは `docker compose up -d` が `-f` なしで通るため。`package.json` の
`files: ["dist"]` により、どこに置いても npm 配布物には影響しない。

代替案の `docker/compose.yaml` は「ai-board 自体は docker で動かない」ことがディレクトリ名から
読み取れる利点があるが、毎回 `-f` が要る。README に「compose が起動するのは GitLab だけで、
ai-board 本体は npm で動かす」と明記することでこの誤読を防ぎ、利便性を取る。

### 2. root パスワードは `.env` から注入する

このリポジトリには既に「トークンは環境変数からのみ読む。設定ファイルには書かない」という
方針がある（`GITLAB_TOKEN_ENV`、README - GitLab 連携）。root パスワードも同じ扱いに揃える。

Docker Compose は `.env` を自動で読むため、`compose.yaml` 側は `${GITLAB_ROOT_PASSWORD}` を
参照するだけでよい。`.env.example` を雛形としてコミットし、`.env` 本体は追跡しない。

代替案は GitLab に自動生成させて `/etc/gitlab/initial_root_password` を `exec` で読む方式。
より安全だが、24 時間で失効するため立て直すたびに手順が増える。ローカル閉域という前提を踏まえ、
再現性を優先する。

### 3. `projectId` は数値ではなく `"group/project"` 文字列で指定する

`GitLabConfigSchema` が両方を受けるため選択できる。GitLab を作り直すと数値 id は変わるが、
名前空間つきパス（例 `root/ai-board`）は変わらない。`HttpGitLabClient` は
`encodeURIComponent(String(projectId))` を通すため、スラッシュを含むパスもそのまま扱える。

立て直しのたびに `.ai-board/config.yaml` を書き換えずに済むこの形を既定とする。

### 3b. `.ai-board/config.yaml` は追跡する

`url` と `projectId` は秘密ではなく、README にも例が載っている。秘匿すべきトークンは
環境変数にしかなく、この分離は `loadConfig()` が構造として保証している。

決定 3 の「名前空間つきパスで指定する」は、GitLab を作り直しても書き換えが要らないことに
価値がある。その価値はファイルが共有されて初めて回収できるため、追跡する側に倒す。

### 4. GitLab のデータは名前つきボリュームに置く

`/etc/gitlab`・`/var/log/gitlab`・`/var/opt/gitlab` の 3 つを名前つきボリュームにする。
macOS の Docker Desktop ではバインドマウントが顕著に遅く、GitLab は I/O が重いため。
リポジトリ内へのマウントは作業ツリーを汚す点でも避ける。

破棄は `docker compose down -v` で完結する。

### 5. `external_url` と公開ポートを一致させる

`HttpGitLabClient.enrich()` は GitLab が返す `web_url` をそのまま `MrState.webUrl` に載せ、
ボードはそれをリンクとして表示する。`external_url` が実際の到達先と食い違っても API は 200 を
返すため、**列は正常に埋まり、リンクだけが静かに壊れる**。

そのため `external_url` は実際にブラウザから開く URL そのもの（例 `http://localhost:8080`）に
設定し、ポートマッピングをそれに一致させる。ポート付き `external_url` を与えたときに GitLab が
内部で待ち受けるポートが 80 のままか指定ポートに追随するかは未検証のため、コンテナ起動後に
実測してマッピングを確定する（下の Risks を参照）。

### 6. PAT はスクリプトで発行する

`gitlab-rails runner` でトークンを生成できれば、疎通確認全体が Web UI に触れずに済み、
`gitlab-mr-loop` でも同じスクリプトを再利用できる。GitLab の内部 API に依存するため
バージョン差の影響を受けうるが、失敗しても Web UI 発行にフォールバックできる。

### 6b. 検証用の MR は GitLab API だけで作る

ボードの AI-PR 列を検証するには実物の MR が要るが、ローカルからブランチを push するには
`git remote` の設定が必要で、それは `gitlab-mr-loop` のスコープである。この change だけで
完結させるため、MR は GitLab 側で完結して作る。

Projects API でプロジェクトを作り、Files API で既定ブランチに 1 ファイル置き、
Branches API と Commits API でブランチとコミットを作り、Merge Requests API で MR を作る。
`fetchByBranch()` の検証にはこれで十分で、ローカルの作業ツリーには一切触れない。

### 7. 不要コンポーネントを omnibus 設定で無効化する

prometheus・grafana・registry はこの用途では使わない。`GITLAB_OMNIBUS_CONFIG` で切り、
puma のワーカー数と sidekiq の並列度を絞ってメモリを削る。

## Risks / Trade-offs

- **`external_url` の誤設定でリンクが静かに壊れる** → 疎通確認に「ボードの列が埋まること」だけでなく
  「API が返した `web_url` に実際に到達できること」を独立した検証項目として含める。緑表示は根拠にしない
- **`.env` の gitignore 漏れでパスワードがコミットされる** → 現在の `.gitignore` に `.env` 行が無い。
  `.env` を作る前に `.gitignore` を更新することをタスクの順序として固定する
- **起動完了まで数分かかり、その間 API が 502 を返す** → compose に healthcheck を定義し、
  疎通確認スクリプトが healthy を待ってから叩くようにする
- **メモリ削減が期待ほど効かない** → 効かなければ常時起動を諦め、「検証するときだけ上げる」運用に倒す。
  ボードは GitLab 停止中も落ちない設計なので、この後退は許容できる
- **`gitlab-rails runner` による PAT 発行が GitLab のバージョン差で動かない** → Web UI での
  発行手順を README に併記し、フォールバック経路を残す

## Open Questions

なし。未確定の 3 点（`external_url` 指定時の内部待ち受けポート、`gitlab-rails runner` の
PAT 発行、メモリ削減幅）はいずれも設計方針ではなく実測で決まる値であり、tasks.md の
検証項目として扱う。
