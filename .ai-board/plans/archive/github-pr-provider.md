# GitHub の PR をボードに乗せる

> openspec の change から移した計画。見出しは 1 段下げてある。

## 提案

### Why

ai-board 自身を GitHub で公開し、開発の主線もそちらへ移した。しかしレビュー要求の状態は
`.ai-board/config.yaml` が指すローカル GitLab からしか取得できないため、GitHub の PR で
回すとカードの `mr` が解決されず、`pr` と `merged` の 2 段が実態を反映しなくなる。
7 段のステージのうち後ろ 2 段が機能しないまま、当面 GitHub で開発を続けることになる。

GitLab を GitHub へ置き換えるのではなく、取得先をもう 1 つ選べるようにする。
ローカル GitLab は検証環境として残す。

あわせて認証をやめる。ai-board はローカル専用ツールであり、利用者の手元には
`gh` / `glab` が既にログイン済みで存在する。そこへ問い合わせを委ねれば、
ai-board がアクセストークンを受け取る必要そのものが無くなる。

### What Changes

- **GitHub の Pull Request をレビュー要求の取得先として選べるようにする。**
  カードの `branch` から PR を解決し、`mr` に書き戻す。取得できる情報は
  GitLab の MR と同じ意味に揃える。
- **BREAKING**: **認証を `gh` / `glab` CLI に委ね、アクセストークンを扱うのをやめる。**
  環境変数 `AI_BOARD_GITLAB_TOKEN` は廃止する。取得先への問い合わせは
  `gh api` / `glab api` の実行として行い、ai-board のプロセスはトークンを
  受け取らない・保持しない・記録しない。
- **取得先を排他選択にする。** `.ai-board/config.yaml` に `gitlab:` と `github:` の
  どちらか一方だけを書く。両方書かれていれば設定エラーとして起動時に落とす。
  どちらも無ければ従来どおり連携は無効になり、ボードは openspec 由来の情報だけで動く。
- **CLI が無い・未ログインなら連携は無効になる。** 起動時に判定し、接続状態として
  理由を示す。ボードは落とさない。
- **レビューコメントの件数と最終時刻は 2 種類を合算する。** GitHub では PR 全体への
  issue comment とコード行への review comment がエンドポイントとして分かれており、
  GitLab の「system でない最新ノート」1 か所と意味を揃えるには両方が要る。
- **BREAKING**: `GET /api/board` が返す接続状態のフィールド名を `gitlab` から
  `forge` へ改める。GitHub 接続時に `gitlab` という名前で状態を返すのは誤りを招く。
  サーバと web は同一リポジトリにあり同じ change で追従するため、外部影響は無い。
- カードの語彙は変えない。frontmatter の `mr` と `MergeRequestIid` は据え置き、
  GitHub では PR number をそこに書く。呼び名はずれるが、値の性質は同じであり、
  既存カード 21 枚とスキーマの移行コストに見合わない。

### Capabilities

#### New Capabilities

- `forge-connection`: レビュー要求のホスティングサービス（GitLab / GitHub）への接続。
  どちらを使うかの排他選択、CLI への認証の委譲、CLI 不在・未ログイン・接続エラー時の
  縮退、カード単位での問い合わせ方針を定める。

#### Modified Capabilities

- `board-stages`: ステージ導出の入力を GitLab 固有の記述から取得先非依存の記述へ改める。
  「3 つの実態（カードファイル・openspec・GitLab の MR）」および
  「PR 中とマージ済みは GitLab の実態で決まる」が、GitLab に限定されなくなる。
  判定の規則そのもの（opened なら `pr`、merged なら `merged`）は変えない。

### Impact

- `src/shared/config.ts`: 設定スキーマに `github` を追加し、排他制約を課す。
  トークンを読む経路（`GITLAB_TOKEN_ENV`）を削除する。有効化の条件が
  「取得先が書かれている」の一条件になる。
- `src/board/services/gitlab-client.ts`: 取得先非依存のクライアント interface を切り出し、
  GitLab 実装と GitHub 実装を並べる。`fetchByIid` / `fetchByBranch` の 2 メソッドで足りる。
  HTTP を直接叩く代わりに CLI を実行する形へ変える。
- `src/infrastructure/gitlab-poller.ts`: ポーラーは 1 つのまま、受け取るクライアントを
  差し替える形にする。キャッシュ・ポーリング間隔・接続状態の縮退は共通で使える。
- `src/board/models/mr-state.ts`: `MR_STATES` の `locked` に GitHub の対応物が無い。
  GitLab 専用の値として残す（design 参照）。
- `src/board/usecases/queries/get-board.query.ts` と `src/web/types.ts`:
  接続状態のフィールド名変更に追従する。
- `.ai-board/config.example.yaml` / `.env.example` / README / CLAUDE.md:
  取得先の選び方と、トークン設定が不要になったことを書く。
  `.env` は compose 用の `GITLAB_ROOT_PASSWORD` だけが残る。
- **新規の外部依存は増やさないが、実行時の前提が増える。** 連携を使うには
  `gh` または `glab` がインストールされ、ログイン済みである必要がある。

## 設計

### Context

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

### Goals / Non-Goals

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

### Decisions

#### 認証は CLI へ委ね、問い合わせは `gh api` / `glab api` の実行にする

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

#### CLI の実行は shell を介さず、引数を配列で渡す

`node:child_process` の `execFile` を使い、`shell: true` は付けない。
ブランチ名・識別番号・リポジトリ指定はすべて引数配列の要素として渡す。

カードファイルは人とエージェントが自由に編集でき、`branch` には任意の文字列が入り得る。
文字列連結でコマンドを組み立てると、カードファイルを書ける者が任意のコマンドを
実行できることになる。ai-board は `127.0.0.1` にのみ bind するローカル専用ツールだが、
それは外からの到達を防ぐだけで、入力の素性を保証しない。

タイムアウトと出力サイズ上限を付け、応答しない CLI がポーリングを止めないようにする。

#### 接続の可否は起動時に 1 度だけ判定する

composition root で `gh auth status` / `glab auth status` を 1 度実行し、
成否を `ForgeConnection` の初期値にする。CLI が見つからない（`ENOENT`）場合と
終了コードが非 0 の場合を区別し、接続状態のメッセージに理由を出す。

**代替案:** 毎回のポーリングで確認する。ログイン状態が変わるのは稀で、
30 秒ごとにプロセスを 1 つ余計に起動する価値が無い。ログインし直した場合は
ai-board の再起動で反映される。

#### GitLab のホストは設定の `url` から解決し、環境変数 `GITLAB_HOST` で渡す

`glab` は複数の GitLab インスタンスにログインでき、既定のホストを持つ。
ai-board の設定が指すホストと `glab` の既定が食い違うと、別インスタンスの
MR を静かに引く。`config.yaml` の `url` からホスト名を取り出して明示的に渡す。

渡し方は当初 `--hostname` を想定していたが、**このフラグはポート付きのホストを
受け付けない**（`glab api --hostname localhost:8929` は
`Error parsing --hostname: invalid hostname.` で落ち、ポートを外すと :443 を叩きに行く）。
検証用の GitLab は `localhost:8929` で動かすため、これでは指定できない。
環境変数 `GITLAB_HOST` はポート付きを受け付けるので、そちらで固定する。

GitHub 側は `gh` の既定ホスト（github.com）を使う。GitHub Enterprise は今回の対象外。


#### 設定は排他とし、違反は起動時の例外にする

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

#### 取得先の抽象は `ForgeClient` として切り出す

`GitLabClient` の 2 メソッドをそのまま `ForgeClient` に改名し、`GhForgeClient` と
`GlabForgeClient` が実装する。ファイルは `src/board/services/forge-client.ts`（interface と
CLI 実行の共通部分）、`gitlab-client.ts` / `github-client.ts`（実装）に分ける。

**代替案:** `MrStateProvider` の層で分ける（ポーラーを 2 つ作る）。
キャッシュ・ポーリング間隔・接続状態の縮退・カードへの書き戻しがすべて複製される。
取得先ごとに違うのは叩く API のパスと応答の写像だけである。

ポーラーは `ForgePoller` に改名し `forge-poller.ts` へ移す。中身は変えない。

#### GitHub の「マージ済み」は `state` からは分からない

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

#### レビューコメントは 2 つのエンドポイントを合算する

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

#### ブランチからの解決

`gh api 'repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all&sort=updated&direction=desc&per_page=1'`
で 1 件だけ引く。GitLab 側と同じく一覧の全件取得はしない。
`head` の `owner:` 接頭辞を落とすと他リポジトリの同名ブランチを拾うため必須。

#### API の接続状態フィールドは `forge` へ改名する

`GET /api/board` の `gitlab` を `forge` にし、値に `kind` を含めて
`{ kind: 'github', status: 'connected' }` の形にする。web は接続バナーの文言を
取得先名で出し分ける。`GitLabConnection` 型は `ForgeConnection` に改名する。

**代替案:** `gitlab` のまま据え置く。GitHub 接続時に `gitlab` というキーで状態を
返すことになり、`.ai-board/` を直接読む道具を書くときに必ず誤読を生む。

### Risks / Trade-offs

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

### Migration Plan

`.ai-board/config.yaml` の `gitlab:` セクションの書式は変わらないため、設定ファイルの
移行は不要。**`AI_BOARD_GITLAB_TOKEN` は不要になるので環境から外してよい。**
残したままでも読まれないだけで害は無い。

GitHub へ切り替える利用者は `gitlab:` を `github:` に書き換え、`gh auth login` を
済ませておく。`.ai-board/config.example.yaml` に両方の例をコメントで併記する。

`package.json` の `dev` / `start` が `--env-file-if-exists=.env` を付けているのは
トークンを渡すためだった。トークンが不要になるため外す。`.env` は compose が読む
`GITLAB_ROOT_PASSWORD` のためだけに残る。

ロールバックは設定ファイルを戻すだけで済む。永続化されたデータの形は変わらない。

## タスク

### 1. 設定からトークンを外し、取得先を排他にする

- [x] 1.1 `src/shared/config.ts` から `GITLAB_TOKEN_ENV` とトークンを読む経路を削除し、
      有効化の条件を「取得先が書かれている」の一条件にする。
      `src/shared/__tests__/config.test.ts` のトークン前提のケースを書き換えて通す
- [x] 1.2 `github` セクション（`repository: 'owner/repo'`）の Zod スキーマを足す。
      GitHub だけ書かれた設定で連携が有効になるテストを足して通す
- [x] 1.3 `gitlab` と `github` が同時に書かれた場合に `loadConfig` が例外を投げるよう
      `superRefine` を足す。両方書いた設定でメッセージ付きの例外が出るテストを足して通す
- [x] 1.4 `AppConfig` の `gitlab: GitLabConfig | null` を
      `forge: ForgeConfig | null`（`kind: 'gitlab' | 'github'` の discriminated union）へ
      置き換える。既存の参照を追従させ `npm run typecheck` が通ることを確認する

### 2. CLI 実行の土台

- [x] 2.1 `src/infrastructure/cli-runner.ts` に `execFile` ベースの実行関数を作る。
      `shell` を使わず引数は配列で渡し、タイムアウトと出力サイズ上限を付ける。
      ブランチ名にシェルの特殊文字を含めてもコマンドとして解釈されないテストを足す
- [x] 2.2 終了コード非 0 と `ENOENT` を区別して返す。CLI が存在しない場合と
      実行が失敗した場合で呼び出し側が理由を出し分けられることをテストで確認する
- [x] 2.3 stdout の JSON をパースするヘルパを作り、空出力・不正 JSON で
      例外ではなく判別可能な失敗を返すことをテストで確認する

### 3. 取得先の抽象

- [x] 3.1 `src/board/services/forge-client.ts` を作り、`GitLabClient` の
      `fetchByIid` / `fetchByBranch` を `ForgeClient` として移す。
      取得先の可否を判定する `checkAuth` も同じ interface に置く
- [x] 3.2 `src/infrastructure/gitlab-poller.ts` を `forge-poller.ts` へ移し
      `ForgePoller` に改名する。受け取る型を `ForgeClient` にするだけで中身は変えない。
      既存の `gitlab-poller.test.ts` を移設し全て通ることを確認する

### 4. GitLab 実装を glab へ載せ替える

- [x] 4.1 `gitlab-client.ts` を `glab api` 実行に書き換える。`config.yaml` の `url` から
      ホスト名を取り出し `--hostname` で明示的に渡す。既定ホストに依存しないことを
      テストで固定する（別インスタンスの MR を引かないため）
- [x] 4.2 `fetchByIid` / `fetchByBranch` / notes / commits の 4 経路を移し、
      既存の `gitlab-client.test.ts` の期待値がそのまま通ることを確認する。
      HTTP スタブを CLI 実行のスタブへ差し替える
- [x] 4.3 `checkAuth` を `glab auth status` で実装し、未ログイン・CLI 不在・成功の
      3 ケースをテストで押さえる

### 5. GitHub 実装

- [x] 5.1 `src/board/services/github-client.ts` に `fetchByIid`
      （`gh api repos/{owner}/{repo}/pulls/{number}`）を実装する。
      `state` / `merged_at` から `MrLifecycleState` への写像を含む
- [x] 5.2 状態の写像をユニットテストで固定する。
      `state: 'open'` → `opened`、`state: 'closed'` かつ `merged_at` 非 null → `merged`、
      `state: 'closed'` かつ `merged_at` が null → `closed` の 3 ケースを最低限置く
- [x] 5.3 `fetchByBranch` を
      `repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all&sort=updated&direction=desc&per_page=1`
      で実装する。`head` に `owner:` 接頭辞が付くことをテストで固定する
      （落とすと他リポジトリの同名ブランチを拾う）
- [x] 5.4 `latestNoteAt` / `noteCount` を issue comment と review comment の
      2 経路から取り、件数は和・時刻は最大値にする。
      片方だけにコメントがある場合と両方にある場合をテストで押さえる
- [x] 5.5 `latestCommitAt` を `repos/{owner}/{repo}/pulls/{number}/commits` の
      最後の要素から取る。取得できない場合に `null` を返すことを確認する
- [x] 5.6 `checkAuth` を `gh auth status` で実装する。存在しない PR 番号で例外を投げず
      `null` を返すことも合わせてテストする
- [x] 5.7 1 枚のカード内の複数呼び出しを並行にする。カード間は既存どおり順次であることを
      変えていないことを確認する

### 6. 組み立てと API

- [x] 6.1 `src/board/composition.ts` で `forge.kind` による `switch` を 1 か所に置き、
      GitLab / GitHub の実装を選ぶ。`forge` が `null` なら `disabledMrStateProvider` に
      落ちる既存の経路を保つ
- [x] 6.2 起動時に `checkAuth` を 1 度だけ呼び、結果を接続状態の初期値にする。
      CLI 不在・未ログインのそれぞれで理由付きの状態になることを確認する
- [x] 6.3 `GitLabConnection` を `ForgeConnection` へ改名し `kind` を持たせる。
      `GET /api/board` の `gitlab` フィールドを `forge` に改める。
      `board.e2e.test.ts` の該当アサーションを追従させて通す
- [x] 6.4 `src/web/types.ts` と接続バナーを `forge` に追従させ、取得先名と
      無効の理由を文言に出す。`STAGE_SOURCE` の `'gitlab'` も改名する。
      `npm run typecheck`（tsconfig.json と tsconfig.web.json の両方）が通ることを確認する

### 7. ドキュメントと仕上げ

- [x] 7.1 `.ai-board/config.example.yaml` に `gitlab:` と `github:` の例を併記し、
      どちらか一方だけを書くこと、および `gh` / `glab` のログインが前提であることを
      コメントで示す
- [x] 7.2 `package.json` の `dev` / `start` から `--env-file-if-exists=.env` を外す。
      トークンが不要になったため。`npm run dev` が起動することを確認する
- [x] 7.3 README の「GitLab 連携」節を取得先の選択と CLI 前提の説明に書き換え、
      `.env.example` からトークンの記述を消す。CLAUDE.md の該当記述も追従させる
- [x] 7.4 `npm run typecheck && npm run lint && npm test` を通す。
      カバレッジ閾値（lines/functions/statements 80%、branches 75%）を
      `npm run test:coverage` で確認する
- [x] 7.5 `AI_BOARD_GITLAB_TOKEN` を環境から外した状態でローカル GitLab に対して
      ボードを動かし、`pr` と `merged` の列が従来どおり埋まることを確認する
- [x] 7.6 設定を `github:` に切り替え、`iepyon/ai-board` の PR に対して
      `pr` と `merged` の列にカードが乗ることを目視で確認する

### 8. 識別番号を取得先と対で持つ

- [x] 8.1 カードの frontmatter に `forge`（`gitlab` / `github` / null）を足す。
      `card.schema.ts` の読み取りと PATCH の両方に加え、既存カードが `forge` を
      持たなくても読めることをテストで確認する
- [x] 8.2 ポーラーの解決順序を変える。取得先が一致すれば番号、一致しなければ
      ブランチ、記録が無ければブランチ優先。ブランチも無く取得先が違えば
      問い合わせない。4 ケースをテストで押さえる
- [x] 8.3 書き戻しで `mr` と `forge` を必ず対にする。ブランチから解決したときに
      両方が書かれることをテストで確認する
- [x] 8.4 既存カードのうち `mr` が書かれている 5 枚に `forge: gitlab` を入れる。
      これまでの番号が GitLab のものだと明示する
- [x] 8.5 README と CLAUDE.md に、番号が取得先ごとに固有であることと
      `forge` 欄の意味を書く
- [x] 8.6 `npm run typecheck && npm run lint && npm test` を通す
- [x] 8.7 設定を `github:` に切り替えてボードを起動し、GitLab の番号を持つカードが
      別の PR に紐付かないことを実機で確認する
