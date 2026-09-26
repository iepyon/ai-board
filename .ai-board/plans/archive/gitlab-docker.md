# Docker Compose で GitLab を立てて接続する

> openspec の change から移した計画。見出しは 1 段下げてある。

## 提案

### Why

ボードの 7 列のうち AI-PR と AI-PR 修正済みの 2 列は、GitLab の MR 状態からしか導出できない。
接続先の GitLab が存在しないため、この 2 列は起動以来一度も実データで埋まったことがなく、
`resolveStage` のルール 2 と 3、および `GitLabPoller` の挙動が実物に対して検証されていない。

ai-board 側の実装は揃っている。`loadConfig()` は設定とトークンが揃えば連携を有効化し、
`HttpGitLabClient` は GitLab REST API v4 に 4 本の GET を投げるだけで、webhook も
GitLab からホストへの到達性も要求しない。欠けているのは接続先そのものである。

ローカルに GitLab を Docker Compose で立て、ボードが実物の API を読んで
AI-PR 列が埋まるところまでを通す。ここで確立する compose・認証情報・疎通確認の手順は、
後続の `gitlab-mr-loop`（ai-board 自身の開発を MR で回す）がそのまま土台にする。

### What Changes

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

### Capabilities

#### New Capabilities

なし。

#### Modified Capabilities

なし。

この change が追加するのは `compose.yaml`・`.env.example`・`.ai-board/config.yaml`・
`.gitignore` の 1 行・README の節だけで、`src/` には一切触れない。

「設定とトークンが揃ったときに GitLab 連携を有効化し、MR 状態から AI-PR 系のステージを
導出する」という振る舞いは既に実装され、`config.test.ts` と `stage-resolver.test.ts` で
検証済みである。この change はその振る舞いに設定値を与えるだけで、システムが満たすべき
要件を変えない。よって `.openspec.yaml` に `skip_specs: true` を設定する。
検証を通すためだけの要件は書かない。

### Impact

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

## 設計

### Context

動機は proposal.md - Why を参照。approach を規定する制約だけを挙げる。

- `loadConfig()`（`src/shared/config.ts`）は `.ai-board/config.yaml` の `gitlab` セクションと
  環境変数 `AI_BOARD_GITLAB_TOKEN` の両方が揃ったときだけ連携を有効にし、欠けても例外にしない。
  設定の投入を段階的に進められる
- `GitLabConfigSchema` の `projectId` は `number | string` を受ける。パス形式の文字列を
  受け付けることは `src/shared/__tests__/config.test.ts` が既に検証している
- `HttpGitLabClient` は `${url}/api/v4/projects/${projectId}` へ `PRIVATE-TOKEN` ヘッダで
  GET を 4 本投げるだけ。webhook もコールバックも使わないため、GitLab からホストへの
  到達性は不要で、ホスト → GitLab の一方向で足りる
- 開発機は arm64 の macOS。Docker Desktop のバインドマウントは低速

### Goals / Non-Goals

**Goals:**

- `docker compose up -d` 一発で GitLab が起動し、ボードが実データを読める状態になること
- 疎通確認が再実行可能なコマンド列であること。Web UI のクリック手順に依存しない
- 認証情報がリポジトリに入らないこと
- この change だけで完結すること。`gitlab-mr-loop` の成果物を前提にしない

**Non-Goals:**

- ローカルからの `git push`。`git remote` の設定は `gitlab-mr-loop` のスコープ
- GitLab の常時起動を前提とした設計。停止中もボードが落ちないことは既存実装が保証している

### Decisions

#### 1. `compose.yaml` はリポジトリ直下に置き、コミットする

`gitlab-mr-loop` で ai-board 自身の MR をこの GitLab に流す以上、compose は使い捨てではなく
恒久的なインフラ定義になる。`.gitignore` には入れない。

直下に置くのは `docker compose up -d` が `-f` なしで通るため。`package.json` の
`files: ["dist"]` により、置き場所は npm 配布物に影響しない。

代替案 `docker/compose.yaml` は「ai-board 自体は docker で動かない」ことがディレクトリ名から
読めるが、毎回 `-f` が要る。README に「compose が起動するのは GitLab だけ、ai-board 本体は
npm で動かす」と明記して誤読を防ぎ、利便性を取る。

#### 2. root パスワードは `.env` から注入する

このリポジトリには「トークンは環境変数からのみ読む。設定ファイルには書かない」という既存方針が
あり、`config.test.ts` の「設定ファイルにトークンを書いても読み取らない」がそれを固定している。
root パスワードも同じ扱いに揃える。

Docker Compose は `.env` を自動で読むため、`compose.yaml` は `${GITLAB_ROOT_PASSWORD}` を
参照するだけでよい。`.env.example` を雛形としてコミットし、`.env` 本体は追跡しない。

代替案は GitLab に自動生成させ `/etc/gitlab/initial_root_password` を `exec` で読む方式。
より安全だが 24 時間で失効し、立て直すたびに手順が増える。ローカル閉域という前提で再現性を取る。

#### 3. `.ai-board/config.yaml` は追跡する

`url` と `projectId` は秘密ではなく、README にも例が載っている。秘匿すべきトークンは
環境変数にしか存在せず、この分離は `loadConfig()` が構造として保証している。

決定 4 の「作り直しても書き換え不要な指定」は、ファイルが共有されて初めて価値を回収できる。

#### 4. `projectId` は数値 id ではなくパス形式の文字列で指定する

GitLab を作り直すと数値 id は変わるが、名前空間つきパス（`root/ai-board`）は変わらない。
`HttpGitLabClient` は `encodeURIComponent(String(projectId))` を通すため、スラッシュを含む
パスもそのまま URL に載る。この経路は `config.test.ts` で検証済みで、新たな前提を持ち込まない。

#### 5. GitLab のデータは名前つきボリュームに置く

`/etc/gitlab`・`/var/log/gitlab`・`/var/opt/gitlab` の 3 つを名前つきボリュームにする。
macOS の Docker Desktop はバインドマウントが顕著に遅く、GitLab は I/O が重い。
リポジトリ内へのマウントは作業ツリーを汚す点でも避ける。破棄は `docker compose down -v` で完結する。

#### 6. `external_url` は実際に開く URL に一致させ、ポートは実測で確定する

`HttpGitLabClient.enrich()` は GitLab が返す `web_url` をそのまま `MrState.webUrl` に載せ、
ボードはそれをリンクとして表示する。`external_url` が実際の到達先と食い違っても GitLab の
API は 200 を返すため、**列は正常に埋まり、リンクだけが静かに壊れる**。型エラーにも
テスト失敗にもならない種類の不具合である。

そこで `external_url` はブラウザから開く URL そのものに設定する。

実測の結果、nginx は `external_url` のポートに追随して待ち受けるため、ポートマッピングは
同一ポート同士にする。ただし **8080 は選べない**。omnibus の puma が既定で `127.0.0.1:8080` に
bind するため nginx と衝突し、puma だけが EADDRINUSE で無限に再起動する。このとき
コンテナは落ちないので `RestartCount` は 0 のまま、Docker の health も `starting` に張り付き、
外からは 502 が返り続ける。コンテナ層のシグナルは一切異常を示さないため、
`gitlab-ctl status` の pid 経過時間を見るまで原因が分からない。

採用値は `external_url 'http://localhost:8929'` と `8929:8929`。8929 は GitLab 公式が
この衝突を避けるために例示しているポートである。

#### 7. 検証用の MR は GitLab API だけで作る

AI-PR 列の検証には実物の MR が要る。しかしローカルからブランチを push するには `git remote` の
設定が必要で、それは `gitlab-mr-loop` のスコープである。この change を自己完結させるため、
MR は GitLab 側で完結して作る。

Projects API でプロジェクトを作り、Files API で既定ブランチにファイルを 1 つ置き、
Branches API と Commits API でブランチとコミットを作り、Merge Requests API で MR を作る。
`fetchByBranch()` の検証にはこれで十分で、ローカルの作業ツリーには触れない。

#### 8. PAT はスクリプトで発行し、UI 発行を残す

`gitlab-rails runner` で PAT を生成できれば疎通確認全体が Web UI に触れずに済み、
`gitlab-mr-loop` でも同じ手順を再利用できる。GitLab の内部 API に依存するためバージョン差の
影響を受けうるが、失敗しても Web UI 発行にフォールバックできる。両方を README に残す。

#### 9. 不要コンポーネントを omnibus 設定で無効化する

prometheus・registry はこの用途では使わない。`prometheus_monitoring['enable'] = false` は
alertmanager と各 exporter もまとめて止める。puma のワーカー数と sidekiq の並列度も絞る。

**grafana は指定してはならない。** omnibus からバンドル削除済みで設定キー自体が存在せず、
`grafana['enable']` を書くと reconfigure が `Mixlib::Config::UnknownConfigOptionError` で
失敗し、コンテナがクラッシュループする。

実測値: この構成での常駐メモリは 2.42 GiB。当初懸念していた 4GB を下回り、常時起動は現実的。

### Risks / Trade-offs

- **`external_url` の誤設定でリンクが静かに壊れる** → 疎通確認に「ボードの列が埋まること」とは
  独立した検証項目として「API が返した `web_url` に実際に到達できること」を置く。
  ボードの緑表示を疎通の根拠にしない
- **`.env` の gitignore 漏れでパスワードがコミットされる** → 現在の `.gitignore` に `.env` 行が無い。
  `.env` を作る前に `.gitignore` を更新する順序をタスクとして固定する
- **起動完了まで数分かかり、その間 API が 502 を返す** → compose に healthcheck を定義し、
  疎通確認は healthy を待ってから実行する
- **メモリ削減が期待ほど効かない** → 効かなければ常時起動を諦め「検証するときだけ上げる」運用に
  倒す。ボードは GitLab 停止中も落ちない設計なのでこの後退は許容できる
- **`gitlab-rails runner` の PAT 発行が GitLab のバージョン差で動かない** → Web UI 発行の手順を
  README に併記してフォールバック経路を残す
- **`skip_specs` により仕様の裏付けが無い** → この change は設定とインフラのみで振る舞いを
  変えないため妥当だが、`gitlab-mr-loop` で運用手順を決める段階では要件が生じうる。
  そこでは skip せず spec を書く

### Open Questions

なし。当初の未確定 3 点のうち 2 点は実測で解決した（決定 6 のポート、決定 9 のメモリ）。
残る 1 点（`gitlab-rails runner` による PAT 発行の可否）も設計方針ではなく手順の可否であり、
決定 8 のとおり失敗時は Web UI 発行にフォールバックする。approach もタスク分割も変わらない。

## タスク

### 1. 秘匿情報の穴を先に塞ぐ

- [x] 1.1 `.gitignore` に `.env` を追加し、`git check-ignore -v .env` がその行を指すことを確認する
- [x] 1.2 `.env.example` を作成して `GITLAB_ROOT_PASSWORD=` の雛形を置く。`.env` を作った上で
      `git status --short` に `.env.example` だけが現れ `.env` が現れないことを確認する

### 2. GitLab を起動する

- [x] 2.1 リポジトリ直下に `compose.yaml` を作成する。`gitlab/gitlab-ce` の単一サービス、
      `/etc/gitlab`・`/var/log/gitlab`・`/var/opt/gitlab` を名前つきボリュームに割り当て、
      `GITLAB_ROOT_PASSWORD` を `.env` から受ける。`docker compose config` が
      エラーなく解決結果を出力することを確認する
- [x] 2.2 `GITLAB_OMNIBUS_CONFIG` に `external_url 'http://localhost:8080'`、
      prometheus / grafana / registry の無効化、puma ワーカー数と sidekiq 並列度の抑制を書く
- [x] 2.3 healthcheck を定義し、`docker compose up -d` の後 `docker compose ps` が
      `healthy` に遷移することを確認する（初回は数分かかる）
- [x] 2.4 **ポートマッピングを実測で確定した。** 結果は当初の想定と異なる。
      nginx は `external_url` のポートに追随して待ち受けるため同一ポートのマッピングが正しいが、
      **8080 は使えない**。omnibus の puma が既定で `127.0.0.1:8080` に bind するため
      nginx と衝突し、puma が EADDRINUSE で無限に再起動して nginx だけが 502 を返し続ける。
      採用: `external_url 'http://localhost:8929'` + `8929:8929`。
      検証は `/-/health` ではなく `curl -s -o /dev/null -w '%{http_code}' http://localhost:8929/users/sign_in`
      が 200 を返すことで行う（`/-/health` は `monitoring_whitelist` により
      コンテナ内からは 200、ホストからは 404 になるため疎通判定に使えない）
- [x] 2.5 常駐メモリを実測した: **2.42 GiB**（Docker VM の 15.58 GiB 中 15.5%）。
      カードが懸念していた 4GB を下回り、常時起動は現実的と判断する。
      内訳上位は puma / sidekiq の ruby 各約 0.95 GiB、gitaly 約 0.34 GiB。
      この値は 7.1 で README に残す

### 3. 認証情報とプロジェクトを用意する

- [x] 3.1 `gitlab-rails runner` で `api` スコープの PAT を発行する手順を確立する。
      得たトークンで `curl -H 'PRIVATE-TOKEN: ...' http://localhost:8080/api/v4/user` が
      200 を返すことを確認する。動かなければ Web UI 発行に切り替え、どちらの手順も README に残す
- [x] 3.2 Projects API で ai-board 用プロジェクトを作成する。
      `curl -H 'PRIVATE-TOKEN: ...' http://localhost:8080/api/v4/projects/root%2Fai-board` が
      200 を返すことを確認する（パス形式で解決できることの確認）

### 4. 検証用の MR を GitLab API だけで作る

ローカルからの `git push` は行わない（`git remote` の設定は `gitlab-mr-loop` のスコープ）。

- [x] 4.1 Files API で既定ブランチにファイルを 1 つコミットし、リポジトリを空でない状態にする。
      `GET /projects/:id/repository/branches` が既定ブランチを 1 本返すことを確認する
- [x] 4.2 Branches API で検証用ブランチを切り、Commits API でそのブランチにコミットを 1 つ足す。
      `GET /projects/:id/repository/commits?ref_name=<branch>` が 2 件以上返すことを確認する
- [x] 4.3 Merge Requests API で MR を作成し、`GET /projects/:id/merge_requests?state=opened` が
      1 件返すことを確認する。返却された `iid` と `web_url` を記録する

### 5. ボードを接続する

- [x] 5.1 `.ai-board/config.yaml` を作成し `gitlab.url` と `gitlab.projectId`
      （`"root/ai-board"` 形式）を設定する。このファイルは追跡するため、
      `git status --short` に現れることを確認する。`npm test` が引き続き 145 件通ることも確認する
- [x] 5.2 `AI_BOARD_GITLAB_TOKEN` を設定した上でボードを起動し、
      `curl -s localhost:<port>/api/board | jq .gitlab` が `{"status":"connected"}` を
      返すことを確認する
- [x] 5.3 カードの `branch` に 4.2 のブランチ名を書き、`fetchByBranch()` 経由で `mr` の iid が
      解決され、4.3 で記録した iid と一致することを確認する

### 6. 疎通の真偽を確かめる

- [x] 6.1 **`web_url` の到達性を独立に検証する。** `/api/board` が返す該当カードの `mr.webUrl` を
      そのままブラウザで開き、対象の MR ページが表示されることを確認する。
      ボードの列が埋まっていることを疎通の根拠にしない（`external_url` の誤設定は
      API 200 のまま `web_url` だけを壊すため）
- [x] 6.2 ボード上で該当カードが AI-PR 列に出ること、`reason` が MR 由来であることを確認する
- [x] 6.3 `docker compose stop` した状態でボードを再読み込みし、ボードが落ちず接続状態が
      `error` を表示することを確認する。`docker compose start` で `connected` に復帰することも確認する

### 7. 手順を残す

- [x] 7.1 README に「ローカル GitLab」の節を追加する。compose が起動するのは GitLab だけで
      ai-board 本体は npm で動かすこと、`.env` の用意、PAT 発行、疎通確認のコマンド列、
      2.4 と 2.5 の実測値を含める
- [x] 7.2 `.ai-board/cards/gitlab-docker.md` の「未検証」3 点を実測値に置き換える
- [x] 7.3 `npm run typecheck && npm run lint && npm test` がすべて通ることを確認する
