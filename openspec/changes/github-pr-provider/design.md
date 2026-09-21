## Context

動機は proposal.md の Why にある。ここでは接ぎ木する先の現状だけを押さえる。

- `MrStateProvider`（`src/board/services/mr-state-provider.ts`）が「ボード描画時に
  ネットワーク I/O をしない」ための抽象で、実体は `GitLabPoller` のキャッシュ。
  未設定時は `disabledMrStateProvider` に落ちる。
- `GitLabPoller`（`src/infrastructure/gitlab-poller.ts`）は `MrStateProvider` を実装し、
  コンストラクタで `GitLabClient` を受け取る。キャッシュ・ポーリング間隔・接続状態の縮退・
  カードへの `mr` 書き戻しは取得先に依存しない。問い合わせ対象は
  `card.mr !== null || card.branch !== null` のカードだけである。
- `GitLabClient` は `fetchByIid` / `fetchByBranch` の 2 メソッドだけを持ち、
  どちらも `MrState | null` を返す。
- `loadConfig`（`src/shared/config.ts`）は設定ファイルが壊れていれば例外を投げ、
  取得先かトークンが欠けていれば `gitlab: null` を返して連携を無効にする。
- ステージ導出（`stage-resolver.ts`）は `MrState` しか見ていない。

差し替え点は既にある。この change で増えるのは「取得先の実装」と「どちらを使うかの
決定」の 2 つで、`stage-resolver.ts` に分岐を足す必要は無い。足したくなったら
`MrState` への写像が間違っている。

## Goals / Non-Goals

**Goals:**

- ai-board のプロセスがアクセストークンを受け取らない状態にする
- `MrState` を取得先非依存の形のまま保ち、GitHub 実装を GitLab 実装と同じ interface で並べる
- ポーラーを 1 つに保つ
- 設定の排他違反を起動時に落とし、実行時に「どちらが効いているか分からない」状態を作らない

**Non-Goals:**

- カード frontmatter の `mr` および `MergeRequestIid` の改名（proposal の決定どおり据え置き）
- 取得先の実行時切り替え。設定は起動時に 1 度だけ読む
- GitHub Actions / GitLab CI の状態の取り込み。レビュー要求の状態のみを扱う
- CLI のインストールやログインを ai-board が行うこと。前提として要求するだけにする

## Decisions

### 認証は CLI へ委ね、問い合わせは `gh api` / `glab api` の実行にする

ai-board はトークンを一切受け取らない。取得先への問い合わせは
`gh api <path>` / `glab api <path>` をサブプロセスとして実行し、stdout の JSON を読む。

**代替案 A: `gh auth token` でトークンを取り出し、従来どおり `fetch` で叩く。**
HTTP クライアントの構造を変えずに済み、呼び出しも速い。採らない理由は非対称性である。
`glab` には token を出力するサブコマンドが無く（`auth` の下は `login` / `logout` /
`status` などで `token` は無い）、GitLab 側で同じ形にできない。取得先ごとに認証の
入手経路が変わると、`forge-connection` の要件が取得先ごとに分岐する。
さらにトークンを ai-board のメモリに載せる時点で、proposal の目的である
「トークンを扱うのをやめる」が達成されない。

**代替案 B: 従来どおり環境変数のトークンを使い続ける。**
利用者が Personal Access Token を発行・保管・失効管理する必要が残る。
ローカル専用ツールのために手作業の資格情報管理を強いる合理性が無い。

この change は「CLI をサブプロセス起動せずディレクトリを直接読む」という
`openspec/` の扱いとは方針が逆になる。理由が違うためである。openspec は
ファイル構造が仕様であり読むだけで足りるが、取得先の認証は CLI の中にしか無い。
読めるものは読み、持ちたくないものは委ねる。

### CLI の実行は shell を介さず、引数を配列で渡す

`node:child_process` の `execFile` を使い、`shell: true` は付けない。
ブランチ名・識別番号・リポジトリ指定はすべて引数配列の要素として渡す。

カードファイルは人とエージェントが自由に編集でき、`branch` には任意の文字列が入り得る。
文字列連結でコマンドを組み立てると、カードファイルを書ける者が任意のコマンドを
実行できることになる。ai-board は `127.0.0.1` にのみ bind するローカル専用ツールだが、
それは外からの到達を防ぐだけで、入力の素性を保証しない。

タイムアウトと出力サイズ上限を付け、応答しない CLI がポーリングを止めないようにする。

### 接続の可否は起動時に 1 度だけ判定する

composition root で `gh auth status` / `glab auth status` を 1 度実行し、
成否を `ForgeConnection` の初期値にする。CLI が見つからない（`ENOENT`）場合と
終了コードが非 0 の場合を区別し、接続状態のメッセージに理由を出す。

**代替案:** 毎回のポーリングで確認する。ログイン状態が変わるのは稀で、
30 秒ごとにプロセスを 1 つ余計に起動する価値が無い。ログインし直した場合は
ai-board の再起動で反映される。

### GitLab のホストは設定の `url` から解決して `--hostname` で渡す

`glab` は複数の GitLab インスタンスにログインでき、既定のホストを持つ。
ai-board の設定が指すホストと `glab` の既定が食い違うと、別インスタンスの
MR を静かに引く。`config.yaml` の `url` からホスト名を取り出して明示的に渡す。

GitHub 側は `gh` の既定ホスト（github.com）を使う。GitHub Enterprise は今回の対象外。

### 設定は排他とし、違反は起動時の例外にする

`ConfigFileSchema` の `gitlab` と `github` を両方 optional にしたうえで、
両方存在する場合に `superRefine` でエラーにする。`loadConfig` は既に設定ファイルが
不正なときに例外を投げるので、その作法に合わせる。

`AppConfig` の `gitlab: GitLabConfig | null` は `forge: ForgeConfig | null` に置き換える。
`ForgeConfig` は `kind: 'gitlab' | 'github'` を持つ discriminated union とし、
composition root が `kind` で実装を選ぶ。判別は 1 か所の `switch` に閉じる。

トークンを読まなくなるため、有効化の条件は「取得先が書かれている」の一条件になる。
`GITLAB_TOKEN_ENV` とそれを読む経路は削除する。

GitHub の設定項目は `repository: 'owner/repo'` の 1 つとする。GitLab が数値 id と
パス形式の両方を受けるのに対し、GitHub は API パスが `owner/repo` 固定なので
数値 id を受ける意味が無い。

### 取得先の抽象は `ForgeClient` として切り出す

`GitLabClient` の 2 メソッドをそのまま `ForgeClient` に改名し、`GhForgeClient` と
`GlabForgeClient` が実装する。ファイルは `src/board/services/forge-client.ts`（interface と
CLI 実行の共通部分）、`gitlab-client.ts` / `github-client.ts`（実装）に分ける。

**代替案:** `MrStateProvider` の層で分ける（ポーラーを 2 つ作る）。
キャッシュ・ポーリング間隔・接続状態の縮退・カードへの書き戻しがすべて複製される。
取得先ごとに違うのは叩く API のパスと応答の写像だけである。

ポーラーは `ForgePoller` に改名し `forge-poller.ts` へ移す。中身は変えない。

### GitHub の「マージ済み」は `state` からは分からない

GitLab の MR は `state` が `opened` / `closed` / `locked` / `merged` の 4 値を取るが、
**GitHub の PR の `state` は `open` / `closed` の 2 値しか取らない。**
マージされた PR も `state` は `closed` で、区別は `merged_at` が非 null かどうかで付く。

したがって GitHub 実装は `state === 'closed' && merged_at !== null` を `merged` へ、
`state === 'closed' && merged_at === null` を `closed` へ、`state === 'open'` を
`opened` へ写す。この写像を間違えるとマージ済みの PR が `closed` に落ち、
カードが `merged` へ進まない。テストで固定する。

`MR_STATES` の `locked` はそのまま残す。GitHub にも `locked` はあるが状態ではなく
真偽値（コメントの凍結）であり、意味が違うので写さない。GitHub 側では現れない値になる。
`MrLifecycleState` を狭めると GitLab 実装が壊れるため、型は触らない。

### レビューコメントは 2 つのエンドポイントを合算する

GitLab は `/merge_requests/{iid}/notes` の 1 か所で、`system: true` を除けば
人のコメントが得られる。GitHub は分かれている。

- `repos/{owner}/{repo}/issues/{number}/comments` — PR 全体への返信
- `repos/{owner}/{repo}/pulls/{number}/comments` — コード行への指摘

`noteCount` は両者の件数の和、`latestNoteAt` は両者の `created_at` の最大値とする。
GitHub の Review（approve / request changes）本体は更に別だが、本文なしの承認まで
「コメント」に数えると GitLab 側と意味がずれるため含めない。

**代替案:** issue comment だけを数える。呼び出しが 1 回減るが、コード行への指摘だけが
付いた PR で件数が 0 になり、再レビュー待ちの判定（`latestCommitAt` と `latestNoteAt`
の比較）が効かなくなる。

### ブランチからの解決

`gh api 'repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all&sort=updated&direction=desc&per_page=1'`
で 1 件だけ引く。GitLab 側と同じく一覧の全件取得はしない。
`head` の `owner:` 接頭辞を落とすと他リポジトリの同名ブランチを拾うため必須。

### API の接続状態フィールドは `forge` へ改名する

`GET /api/board` の `gitlab` を `forge` にし、値に `kind` を含めて
`{ kind: 'github', status: 'connected' }` の形にする。web は接続バナーの文言を
取得先名で出し分ける。`GitLabConnection` 型は `ForgeConnection` に改名する。

**代替案:** `gitlab` のまま据え置く。GitHub 接続時に `gitlab` というキーで状態を
返すことになり、`.ai-board/` を直接読む道具を書くときに必ず誤読を生む。

## Risks / Trade-offs

- **CLI の存在とログインが実行時の前提になる** → 前提を満たさない環境では連携が
  無効になるだけでボードは動く。理由を接続状態に出し、README に前提を明記する。
  clone した人が最初に見るのがこの縮退表示になるため、文言は丁寧に書く。
- **サブプロセス起動の分だけ遅く重くなる** → 実測で `gh api` 1 回あたり約 0.4 秒
  （うちプロセス起動は 0.03 秒で、ほぼネットワーク待ち）。問い合わせ対象は
  ブランチまたは `mr` が書かれたカードだけで現在 6 枚、1 枚あたり最大 4 回。
  30 秒間隔に収まる。カード内の複数呼び出しは並行にし、カード間は既存どおり順次とする。
  前回の実行が終わっていなければ skip する既存の防護もそのまま効く。
- **CLI の出力形式が将来変わり得る** → `gh api` / `glab api` は取得先の REST 応答を
  そのまま返す薄い経路であり、整形済みの人間向け出力に依存しない。
  依存するのは取得先の API の形であって CLI の表示ではない。
- **`merged_at` の写像を落とすとマージ済みが `merged` にならない** → 上記の写像を
  ユニットテストで固定する。`state: 'closed'` かつ `merged_at` 非 null の固定データを置く。
- **`forge` への改名が web の型と e2e テストに波及する** → サーバと web は同じ
  tsconfig 群で型検査されるため、追従漏れは `npm run typecheck` が検出する。
  `src/web/` は vitest の対象外なので、UI 側の担保は typecheck と lint に依る。
- **`locked` が GitHub では現れない** → `MrLifecycleState` に到達不能な値が残る。
  型を狭めるより、取得先ごとに取り得る値が違うことを許す方が安い。

## Migration Plan

`.ai-board/config.yaml` の `gitlab:` セクションの書式は変わらないため、設定ファイルの
移行は不要。**`AI_BOARD_GITLAB_TOKEN` は不要になるので環境から外してよい。**
残したままでも読まれないだけで害は無い。

GitHub へ切り替える利用者は `gitlab:` を `github:` に書き換え、`gh auth login` を
済ませておく。`.ai-board/config.example.yaml` に両方の例をコメントで併記する。

`package.json` の `dev` / `start` が `--env-file-if-exists=.env` を付けているのは
トークンを渡すためだった。トークンが不要になるため外す。`.env` は compose が読む
`GITLAB_ROOT_PASSWORD` のためだけに残る。

ロールバックは設定ファイルを戻すだけで済む。永続化されたデータの形は変わらない。
