## Context

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

## Goals / Non-Goals

**Goals:**

- `docker compose up -d` 一発で GitLab が起動し、ボードが実データを読める状態になること
- 疎通確認が再実行可能なコマンド列であること。Web UI のクリック手順に依存しない
- 認証情報がリポジトリに入らないこと
- この change だけで完結すること。`gitlab-mr-loop` の成果物を前提にしない

**Non-Goals:**

- ローカルからの `git push`。`git remote` の設定は `gitlab-mr-loop` のスコープ
- GitLab の常時起動を前提とした設計。停止中もボードが落ちないことは既存実装が保証している

## Decisions

### 1. `compose.yaml` はリポジトリ直下に置き、コミットする

`gitlab-mr-loop` で ai-board 自身の MR をこの GitLab に流す以上、compose は使い捨てではなく
恒久的なインフラ定義になる。`.gitignore` には入れない。

直下に置くのは `docker compose up -d` が `-f` なしで通るため。`package.json` の
`files: ["dist"]` により、置き場所は npm 配布物に影響しない。

代替案 `docker/compose.yaml` は「ai-board 自体は docker で動かない」ことがディレクトリ名から
読めるが、毎回 `-f` が要る。README に「compose が起動するのは GitLab だけ、ai-board 本体は
npm で動かす」と明記して誤読を防ぎ、利便性を取る。

### 2. root パスワードは `.env` から注入する

このリポジトリには「トークンは環境変数からのみ読む。設定ファイルには書かない」という既存方針が
あり、`config.test.ts` の「設定ファイルにトークンを書いても読み取らない」がそれを固定している。
root パスワードも同じ扱いに揃える。

Docker Compose は `.env` を自動で読むため、`compose.yaml` は `${GITLAB_ROOT_PASSWORD}` を
参照するだけでよい。`.env.example` を雛形としてコミットし、`.env` 本体は追跡しない。

代替案は GitLab に自動生成させ `/etc/gitlab/initial_root_password` を `exec` で読む方式。
より安全だが 24 時間で失効し、立て直すたびに手順が増える。ローカル閉域という前提で再現性を取る。

### 3. `.ai-board/config.yaml` は追跡する

`url` と `projectId` は秘密ではなく、README にも例が載っている。秘匿すべきトークンは
環境変数にしか存在せず、この分離は `loadConfig()` が構造として保証している。

決定 4 の「作り直しても書き換え不要な指定」は、ファイルが共有されて初めて価値を回収できる。

### 4. `projectId` は数値 id ではなくパス形式の文字列で指定する

GitLab を作り直すと数値 id は変わるが、名前空間つきパス（`root/ai-board`）は変わらない。
`HttpGitLabClient` は `encodeURIComponent(String(projectId))` を通すため、スラッシュを含む
パスもそのまま URL に載る。この経路は `config.test.ts` で検証済みで、新たな前提を持ち込まない。

### 5. GitLab のデータは名前つきボリュームに置く

`/etc/gitlab`・`/var/log/gitlab`・`/var/opt/gitlab` の 3 つを名前つきボリュームにする。
macOS の Docker Desktop はバインドマウントが顕著に遅く、GitLab は I/O が重い。
リポジトリ内へのマウントは作業ツリーを汚す点でも避ける。破棄は `docker compose down -v` で完結する。

### 6. `external_url` は実際に開く URL に一致させ、ポートは実測で確定する

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

### 7. 検証用の MR は GitLab API だけで作る

AI-PR 列の検証には実物の MR が要る。しかしローカルからブランチを push するには `git remote` の
設定が必要で、それは `gitlab-mr-loop` のスコープである。この change を自己完結させるため、
MR は GitLab 側で完結して作る。

Projects API でプロジェクトを作り、Files API で既定ブランチにファイルを 1 つ置き、
Branches API と Commits API でブランチとコミットを作り、Merge Requests API で MR を作る。
`fetchByBranch()` の検証にはこれで十分で、ローカルの作業ツリーには触れない。

### 8. PAT はスクリプトで発行し、UI 発行を残す

`gitlab-rails runner` で PAT を生成できれば疎通確認全体が Web UI に触れずに済み、
`gitlab-mr-loop` でも同じ手順を再利用できる。GitLab の内部 API に依存するためバージョン差の
影響を受けうるが、失敗しても Web UI 発行にフォールバックできる。両方を README に残す。

### 9. 不要コンポーネントを omnibus 設定で無効化する

prometheus・registry はこの用途では使わない。`prometheus_monitoring['enable'] = false` は
alertmanager と各 exporter もまとめて止める。puma のワーカー数と sidekiq の並列度も絞る。

**grafana は指定してはならない。** omnibus からバンドル削除済みで設定キー自体が存在せず、
`grafana['enable']` を書くと reconfigure が `Mixlib::Config::UnknownConfigOptionError` で
失敗し、コンテナがクラッシュループする。

実測値: この構成での常駐メモリは 2.42 GiB。当初懸念していた 4GB を下回り、常時起動は現実的。

## Risks / Trade-offs

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

## Open Questions

なし。当初の未確定 3 点のうち 2 点は実測で解決した（決定 6 のポート、決定 9 のメモリ）。
残る 1 点（`gitlab-rails runner` による PAT 発行の可否）も設計方針ではなく手順の可否であり、
決定 8 のとおり失敗時は Web UI 発行にフォールバックする。approach もタスク分割も変わらない。
