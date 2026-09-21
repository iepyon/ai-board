## 1. 設定からトークンを外し、取得先を排他にする

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

## 2. CLI 実行の土台

- [x] 2.1 `src/infrastructure/cli-runner.ts` に `execFile` ベースの実行関数を作る。
      `shell` を使わず引数は配列で渡し、タイムアウトと出力サイズ上限を付ける。
      ブランチ名にシェルの特殊文字を含めてもコマンドとして解釈されないテストを足す
- [x] 2.2 終了コード非 0 と `ENOENT` を区別して返す。CLI が存在しない場合と
      実行が失敗した場合で呼び出し側が理由を出し分けられることをテストで確認する
- [x] 2.3 stdout の JSON をパースするヘルパを作り、空出力・不正 JSON で
      例外ではなく判別可能な失敗を返すことをテストで確認する

## 3. 取得先の抽象

- [x] 3.1 `src/board/services/forge-client.ts` を作り、`GitLabClient` の
      `fetchByIid` / `fetchByBranch` を `ForgeClient` として移す。
      取得先の可否を判定する `checkAuth` も同じ interface に置く
- [x] 3.2 `src/infrastructure/gitlab-poller.ts` を `forge-poller.ts` へ移し
      `ForgePoller` に改名する。受け取る型を `ForgeClient` にするだけで中身は変えない。
      既存の `gitlab-poller.test.ts` を移設し全て通ることを確認する

## 4. GitLab 実装を glab へ載せ替える

- [x] 4.1 `gitlab-client.ts` を `glab api` 実行に書き換える。`config.yaml` の `url` から
      ホスト名を取り出し `--hostname` で明示的に渡す。既定ホストに依存しないことを
      テストで固定する（別インスタンスの MR を引かないため）
- [x] 4.2 `fetchByIid` / `fetchByBranch` / notes / commits の 4 経路を移し、
      既存の `gitlab-client.test.ts` の期待値がそのまま通ることを確認する。
      HTTP スタブを CLI 実行のスタブへ差し替える
- [x] 4.3 `checkAuth` を `glab auth status` で実装し、未ログイン・CLI 不在・成功の
      3 ケースをテストで押さえる

## 5. GitHub 実装

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

## 6. 組み立てと API

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

## 7. ドキュメントと仕上げ

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

## 8. 識別番号を取得先と対で持つ

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
