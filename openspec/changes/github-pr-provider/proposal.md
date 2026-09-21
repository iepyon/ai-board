## Why

ai-board 自身を GitHub で公開し、開発の主線もそちらへ移した。しかしレビュー要求の状態は
`.ai-board/config.yaml` が指すローカル GitLab からしか取得できないため、GitHub の PR で
回すとカードの `mr` が解決されず、`pr` と `merged` の 2 段が実態を反映しなくなる。
7 段のステージのうち後ろ 2 段が機能しないまま、当面 GitHub で開発を続けることになる。

GitLab を GitHub へ置き換えるのではなく、取得先をもう 1 つ選べるようにする。
ローカル GitLab は検証環境として残す。

あわせて認証をやめる。ai-board はローカル専用ツールであり、利用者の手元には
`gh` / `glab` が既にログイン済みで存在する。そこへ問い合わせを委ねれば、
ai-board がアクセストークンを受け取る必要そのものが無くなる。

## What Changes

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

## Capabilities

### New Capabilities

- `forge-connection`: レビュー要求のホスティングサービス（GitLab / GitHub）への接続。
  どちらを使うかの排他選択、CLI への認証の委譲、CLI 不在・未ログイン・接続エラー時の
  縮退、カード単位での問い合わせ方針を定める。

### Modified Capabilities

- `board-stages`: ステージ導出の入力を GitLab 固有の記述から取得先非依存の記述へ改める。
  「3 つの実態（カードファイル・openspec・GitLab の MR）」および
  「PR 中とマージ済みは GitLab の実態で決まる」が、GitLab に限定されなくなる。
  判定の規則そのもの（opened なら `pr`、merged なら `merged`）は変えない。

## Impact

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
