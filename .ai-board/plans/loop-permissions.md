# ループに要る操作の許可ルールを `.claude/settings.json` に同梱する

## 提案

### Why

ループの監視役とサブエージェント（`board-planner` / `board-worker` / `board-reviewer`）は、1 手のあいだに git・npm・`ai-board` の CLI を何度も呼ぶ。
今の `.claude/settings.json` には、データのワークツリーへの書き込みとデータ用ブランチへの push を止める deny ルールしか無い。
許すルールが無いので、受講者は 1 手ごとに確認の応答に追われ、応答を待つ間ループは「止まっている」ように見える。
2026-10-31 には、自動許可の判定が実装の開始を自己承認と見なして止めたこともあった。

確認が多すぎると、受講者は場当たりで「全部許す」を選びがちになる。
ループに要る操作だけを明文化して許し、ハーネスの境界を壊す操作は明文化して禁じておけば、確認の数も、何でも許してしまう危うさも減らせる。

### What Changes

使う人から見た変化は次のとおり。

- clone してループを回すと、手順書が使う操作（品質ゲート、`ai-board` の CLI、決まった `git` の操作、カードのワークツリーの中の編集）で確認が出なくなる
- 境界を壊す操作（`main` への push、force push、DB の直接操作など）は、許可の確認を経ずに拒まれる
- 取り返しのつきにくい操作（`git reset --hard`、ブランチの削除、ワークツリーの削除、`ai-board migrate`）は、許すでも禁じるでもなく、毎回人に確かめる
- README に「ループの許可ルール」の節が増え、何を許し何を禁じたかと、その理由が読める。判断の理由と捨てた代案は ADR に残す

中の仕組みの変化は次のとおり。

- `.claude/settings.json` の `permissions` に `allow` と `ask` を足し、`deny` を増やす
- 許可ルールの形を守るテストを足す（禁じるべきものが `deny` にあること、広すぎるルールが `allow` に無いこと）

### Impact

- 設定: `.claude/settings.json`
- テスト: `src/__tests__/claude-settings.test.ts`（新規）
- ドキュメント: `README.md`、`CLAUDE.md`（書き込み境界の節から 1 行で指す）、`docs/adr/0012-loop-permissions.md`（新規）と `docs/adr/README.md` の表
- コードの振る舞いは変わらない。サーバ・CLI・ステージの導出には触らない

## 設計

### Decisions

#### 3 段に分ける（allow / ask / deny）

Claude Code の許可ルールは `deny` → `ask` → `allow` の順に評価され、どれにも当たらなければ確認が出る。
これを使って、操作を次の 3 つに分ける。

| 段      | 何を入れるか                                           | 当たったとき         |
| ------- | ------------------------------------------------------ | -------------------- |
| `allow` | 手順書が毎手のように使い、壊しても PR とゲートで戻せる | 確認なしで走る       |
| `ask`   | 手順書が使わないか、人が 1 回だけ行う、戻しにくい操作  | 毎回人に確かめる     |
| `deny`  | ハーネスの境界を壊す。人もループ中には使わない         | 確認を経ずに拒まれる |

`ask` を設けるのは、`deny` にすると人がチャットで頼んだ正当な操作（README の CRLF の取り出し直しの `git reset --hard` など）まで止まり、
何も書かないと `allow` に紛れた広いルールに飲まれうるからである。

#### `allow` に入れるもの

手順書（`.claude/skills/board-loop/`、`.claude/agents/board-*.md`、`subagent-rules.md`）が実際に使う形に合わせる。
CLI は `node "$MAIN/dist/cli.js" ...` で呼ばれるので、`ai-board` という名前ではなく `node */dist/cli.js <サブコマンド> *` の形で書く。

- 品質ゲートとビルド: `npm run typecheck` / `lint` / `format` / `format:check` / `build` / `test:coverage`、`npm test`、`npm ci`、`npx vitest run *`
- `ai-board` の CLI: `card` / `pr` / `status` / `loop` のサブコマンド。`migrate` は入れない（`ask`）
  - `card` で書けるものは CLI が構造で絞っている（`startedAt` / `rank` / 承認 / 否決 / 中止は書けない）ので、`card` は丸ごと許してよい
  - `pr` に merge は無い（`create` / `view` / `edit` / `comment` / `diff` / `ready` だけ）
- `git`: `status` / `diff` / `log` / `show` / `fetch` / `pull --ff-only` / `add` / `commit` / `mv` / `rev-parse` / `worktree list` / `worktree add` / `push`（`-u origin <branch>` を含む）、
  ワークツリーの中の取り消し（`checkout -- .`、`clean -fd`。`board-worker` が節の途中で止まるときに使う）。どれも `git -C <path> ...` の形も許す
- 編集: カードのワークツリーの下（`Edit(/.claude/worktrees/**)` / `Write(/.claude/worktrees/**)`）。メインのチェックアウトの編集は許さず、今どおり確認を出す
- `cd`、`ls`、`cat` などの読むだけの操作は、Claude Code が既定で許す範囲に任せ、ここには書かない

`gh` は許さない。手順書は PR の読み書きに `ai-board pr` を使い（クラウドでは `gh pr` が GraphQL の 403 で動かない）、
`ai-board` の中から呼ぶ `gh api` は Bash の道具を通らないので、許可ルールの対象にならない。
カードの「アイデア」にある `gh pr create --draft` / `gh pr ready` の許可は、今の手順書には要らない。

`node -e` と `curl` は許さない。`node -e` は任意のコードを走らせられ、`curl` で人の API（`/api/...`）を叩けば人の判断を書ける。
`board-decide`（人がチャットで頼んだときだけ使う）はこの 2 つを使うので、人のセッションでは確認が出るが、人が頼んだ操作なので確認は妥当とする。

#### `deny` に足すもの

- `main` への push: `git push * main`、`git push * HEAD:main`、`git push * *:main`、`git -C * push ...` の同じ形
- force push: `--force` / `--force-with-lease` / `-f` を含む `git push`、`+` で始まる refspec
- DB の直接操作: `sqlite3 *`（カードの正本はデータ用ブランチに移ったが、古いチェックアウトに `board.db` が残りうる）
- ループの設定そのものの編集: メインのチェックアウトの `Edit(/.claude/settings*.json)` / `Write(/.claude/settings*.json)`。
  ワークツリーの中の `.claude/settings.json` は PR で人が読むので止めない（このカード自身の実装もそこを書く）
- 今ある deny（データのワークツリーの編集、データ用ブランチへの push）は残す

#### `ask` に入れるもの

`git reset --hard`、`git branch -D` / `-d`、`git worktree remove`、`node */dist/cli.js migrate *`。
どれも手順書の 1 手の中では使わず、使うなら人が意図して 1 回行う操作である。

#### 許可ルールは境界の保険で、境界そのものではない

Bash の許可ルールは前方一致の文字列の照合で、`git -c x push --force`、`bash -c '...'`、環境変数を前に付けた形などで迂回できる。
`deny` はうっかりの事故を止める保険とし、境界の本体は今どおり次に置く。

- カードの書き込み: `ai-board card` の CLI の構造（`src/cards/cli/card-cli.ts`）
- 人の判断: `board-decide` と人の API を使わないという手順書の決まり
- `main` の保護: GitHub のブランチ保護（人がリポジトリの設定で入れる。このカードでは README で勧めるだけ）

#### 説明をどこに書くか

カードは `harness-guide` に書くとしているが、このリポジトリに `harness-guide` という文書は無い。
README に「ループの許可ルール」の節を足して、何を許し・確かめ・禁じたかと理由を書き、判断の理由と捨てた代案を ADR 0012 に残す。
`harness-guide` が研修の別の教材を指すなら、そちらへの転記はこのカードの外とする（判断してほしい点）。

#### 形をテストで守る

`src/__tests__/claude-settings.test.ts` で `.claude/settings.json` を読み、次を確かめる。

- JSON として読め、`permissions.allow` / `ask` / `deny` が文字列の配列である
- `deny` に、データのワークツリーの編集・データ用ブランチへの push・`main` への push・force push・`sqlite3` が入っている
- `allow` に、広すぎるルール（`Bash`、`Bash(*)`、`Bash(git *)`、`Bash(node *)`、`Bash(gh *)`、`Bash(curl *)`、`Bash(node -e *)`）と `migrate` を含むルールが無い
- `allow` と `deny` に同じ文字列が無い

許可ルールの照合そのもの（Claude Code の挙動）はテストできないので、動作確認で人が確かめる。

### Risks / Trade-offs

- **迂回できる。** 前の節のとおり、`deny` は前方一致で迂回できる。保険と割り切り、境界の本体を CLI の構造と GitHub のブランチ保護に置く
- **auto モードの判定とは別物である。** 2026-10-31 の止まりは自動許可の判定によるもので、`allow` に書いても判定が同じ操作を止めることはありうる。
  動作確認でループを 1 手回して、確認や判定の止まりが減ったかを見る
- **手順書が変わると許可ルールが古くなる。** 新しい操作を手順書に足したら、確認が出て気づける（危険側には倒れない）。README の節に「手順書に操作を足したら許可ルールも見直す」と書く
- **`allow` の `git push` が広い。** `push` を許すと、`deny` に当たらない形の `main` への push（`git push` だけで上流が `main` のとき）は通りうる。
  ワークツリーのブランチは `origin/main` を追跡して作られる（`subagent-rules.md` の `worktree add -b <id> ... origin/main`）ので、`git push` だけの形は許さず、`git push -u origin <branch>` と、上流を設定した後の `git -C * push` に絞るかは実装で確かめる。
  絞れないなら `git push` は `allow` に入れず、手順書を `git push origin <branch>` の明示の形に揃える

### Non-Goals

- `~/.claude/settings.json`（人ごとの設定）や `settings.local.json` には触らない
- `defaultMode`（`acceptEdits` など）は変えない。どのモードで回すかは人が選ぶ
- GitHub のブランチ保護の設定は入れない（README で勧めるだけ）
- `harness-guide`（研修の別の教材）への転記はしない
- サーバ・CLI・ステージの導出の振る舞いは変えない

## 動作確認の手順

1. ワークツリーで品質ゲートを通す（`npm run typecheck && npm run lint && npm run format:check && npm test`）。`claude-settings.test.ts` が通ることを見る
2. このブランチを clone した新しいディレクトリで Claude Code を開き、`/permissions` で `allow` / `ask` / `deny` が `.claude/settings.json` のとおりに読まれていることを見る
3. 同じセッションで次を頼み、期待どおりかを見る（共有のカードを汚さないよう、カードを書く操作は `AI_BOARD_DATA` でスクラッチの clone を指す。手順は `subagent-rules.md` の「動かして確かめるとき」）
   - `npm run typecheck`、`git status`、`node dist/cli.js status` は確認なしで走る
   - `git push --force origin x`、`git push origin main`、`sqlite3 .ai-board/board.db` は確認なしに拒まれる
   - `git reset --hard` は確認が出る
   - `.claude/worktrees/<何か>/` の下のファイルの編集は確認なしで、メインのチェックアウトの `src/` の編集は確認が出る
4. 着手済みのダミーのカードで `/board-loop` を 1 手回し、`plan` の手が確認なしに Draft の PR まで進むことを見る
   （PR を作るので、試し用のリポジトリか、後で閉じる前提の PR で行う）
5. README の「ループの許可ルール」の節を読み、許す・確かめる・禁じるの理由が分かることを見る

## タスク

### 1. 許可ルールとテスト

- [ ] `.claude/settings.json` に `allow` / `ask` を足し、`deny` を増やす（Decisions の「`allow` に入れるもの」「`deny` に足すもの」「`ask` に入れるもの」のとおり）
  - `git push` の扱いを Risks のとおり確かめ、絞れないなら `allow` から外して手順書の push を `git push origin <branch>` の明示の形に揃える
- [ ] `src/__tests__/claude-settings.test.ts` を足す（Decisions の「形をテストで守る」の 4 点）

### 2. ドキュメント

- [ ] `README.md` の「AI ループ」の後に「ループの許可ルール」の節を足す（3 段の分け方、それぞれに入れたものと理由、迂回できる保険であること、`main` のブランチ保護を勧めること、手順書に操作を足したら見直すこと）
- [ ] `CLAUDE.md` の書き込み境界の節の deny ルールの記述を、README の新しい節を指す 1 行に直す
- [ ] `adr` のスキルで `docs/adr/0012-loop-permissions.md` を書き、`docs/adr/README.md` の表に足す（3 段に分けた理由、`gh` / `node -e` / `curl` を許さない理由、許可ルールを境界の本体にしない理由と捨てた代案）

### 3. 確かめる

- [ ] 品質ゲートと `npm run build` を通し、`## 動作確認の手順` の 1 と 3 のうち、サブエージェントの中で確かめられるもの（許されたコマンドが確認なしに走ること）を確かめる
