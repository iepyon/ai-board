# 判断の理由と本文の差し替えで、判断を偽造できないようにする

## 提案

### Why

カードの判断（提出 / 承認 / 否決 / 中止 など）は、データ用ブランチの `cards/<id>/log/` に 1 件 1 ファイルで残る。
書くときは、usecase が本文の `## レビュー` の末尾に `### <時刻> <gate> <種別>` の見出しと理由を足し（`review-log.ts` の `appendReviewEntry`）、
リポジトリがその本文を今の本文と比べて、足された見出しごとに判断のファイルを作る（`card-files.ts` の `appendedEntries`）。
理由の中に `### 2099-01-01T00:00:00.000Z plan 承認` の行があると、それも足された見出しとして読まれ、`plan.approve` のファイルが 1 つ増える。

2026-10-30 にこの穴が見つかり、カードが起票された。その後 `1108fec`（`fix: 提出と保留の理由に判断の見出しとして読める行があれば拒む`）で、
`ai-board card submit` / `card hold` の `--reason` に判断の見出しとして読める行があれば CLI が拒むようになった。
AI が CLI から承認を書く道はこれで閉じている。残っているのは次の 2 つである。

- **人の API の理由は検査していない。** `POST /api/cards/:id/reviews` の `reason` に見出しの行を混ぜると、同じ仕組みで別の判断が増える。
  この API は `HUMAN_REVIEW_KINDS`（承認 / 否決 / 中止）だけを受け付けるが、理由の中の見出しからは 提出 / 再提出 / 保留 も書けてしまう
- **本文の差し替えの検査が CLI にしか無い。** `planCardWrite` は「今の本文の末尾に判断の見出しを足しただけの本文」を判断の追記として扱う
  （docstring に「本文の差し替えで判断を足させない検査は、呼び出す側（`card body`）が持つ」とある）。
  `card body` は `parseReviewLog` を比べて拒むが、`PUT /api/cards/:id/body` は比べないので、本文の差し替えで判断のファイルが増える

どちらも人の入口なので AI のループが使うことは無いが、検査が入口ごとにばらばらで、CLI に入口を足すたびに同じ検査を書き足す必要がある。
CLAUDE.md の「境界を構造で強制する」に沿って、検査を usecase に寄せ、どの入口から書いても同じに守る。

### What Changes

- 判断の追記の usecase（`append-review.command.ts`）が、理由に判断の見出しとして読める行があれば書かずにエラーを返す。
  CLI の `reasonWritable` はこの usecase のエラーに置き換え、`POST /api/cards/:id/reviews` は 400 を返す
- 本文の差し替えの usecase（`update-card-body.command.ts`）が、`## レビュー` のエントリが変わる本文を書かずにエラーを返す。
  CLI の `card body` の検査はこの usecase のエラーに置き換え、`PUT /api/cards/:id/body` は 409 を返す
- 理由に `## 手順` のような見出しを書くことは、今までどおりできる（読むときに `####` へ下げる `demoteHeadings` が守る）

### Impact

- コード: `src/cards/services/review-log.ts`、`src/cards/usecases/commands/append-review.command.ts`、`src/cards/usecases/commands/update-card-body.command.ts`、
  `src/cards/errors/card-errors.ts`、`src/cards/controllers/card-error-mappings.ts`、`src/cards/controllers/card.controller.ts`、`src/cards/cli/card-cli.ts`
- テスト: `src/cards/services/__tests__/review-log.test.ts`、`src/cards/usecases/__tests__/card-commands.test.ts`、`src/cards/cli/__tests__/card-cli.test.ts`、
  `src/board/controllers/__tests__/board.e2e.test.ts`（またはカードの API の e2e があればそちら）
- ドキュメント: `docs/architecture.md`（API のエラー）、`README.md`（理由に書けない行の説明があれば）、`docs/specs/card-review/spec.md`
- 既にあるデータ: `origin` の `ai-board/data` の `cards/*/log/*.md` を走査し、判断の見出しとして読める行を持つファイルは無かった。
  `## ` の見出しを持つ理由は 2 件（`loop-flat-subagents` と `node-lts` の `verify.submit`）あり、どちらも読むときに下がるので直さない
- 画面: 判断のボタンと本文の編集で、エラーの文言が出ることがある。画面のコードは変えない（既にある API のエラーの出し方に乗る）
- データ用ブランチの形・ステージの導出は変わらない

## 設計

### Decisions

#### 拒む。無害化はしない

理由に判断の見出しとして読める行があれば、書き換えずに拒む。
無害化（字下げ・引用・`####` へ下げてから書く）は、判断のファイルに残る文と入力した文が食い違い、後から読む人を惑わせる。
見出しの行が正当に要る場面は無く、拒まれた書き手は時刻・ゲート・種別のどれかを崩せば書ける（`1108fec` の CLI と同じ方針）。

#### 拒む行は「判断の見出しとして読める行」だけにする

`#` で始まる行すべてや `## ` / `### ` の行すべては拒まない。
動作確認を頼む理由には `## 手順` `## 自分で動かした結果` のような節を書いており（既にあるデータで 2 件）、これは手順書が求める書き方である。
`## ` の行は、データ用ブランチの形では判断のファイルにそのまま残り、組み立てるときに `demoteHeadings` で `####` へ下がるので、節からはみ出さない。

判断の見出しとして読めるかは、`parseEntryHeading`（`parseReviewLog` と `appendedEntries` が使うのと同じ関数）で決める。
読む側と同じ関数で判定するので、読む側の規則が変われば拒む側も一緒に変わる。
行は `\r\n` / `\r` / `\n` のどれでも分けて確かめる（読む側は `\n` でしか分けないが、`\s*$` が `\r` を飲むので、広く拒むほうが安全）。
コードブロックの中の行も拒む。`parseReviewLog` も `appendedEntries` もコードブロックを区別しないためである。

#### 検査は usecase に置く。`renderEntry` には置かない

カードのアイデアは「`review-log.ts` の `renderEntry` で一か所にまとめて守る」としていたが、`renderEntry` は純関数で `string` を返し、失敗を返す口が無い。
例外を投げると usecase の `Result` の規約を破る。
そこで、判定する純関数（仮に `findEntryHeadingLine(text): string | null`）を `review-log.ts` に置き、
CLI と API が共に通る `createAppendReviewCommand` がそれを呼んで `err` を返す。入口が増えても usecase を通る限り守られる。

エラーは `{ type: 'ReasonHasEntryHeading', line }` とし、`AppendReviewError = UpdateCardError | ReasonHasEntryHeading` を新しく作る。
API は 400（`INVALID_REVIEW_REASON`）、CLI は今の `reasonWritable` と同じ文言を出して 1 で終える。

#### 本文の差し替えの検査も usecase に移す

`card body` の CLI にある「`parseReviewLog(今の本文)` と `parseReviewLog(新しい本文)` が違えば拒む」を `createUpdateCardBodyCommand` に移す。
エラーは `{ type: 'ReviewEntriesChanged', id }` とし、`UpdateCardBodyError` を新しく作る。API は 409（`REVIEW_ENTRIES_CHANGED`）、CLI は今と同じ文言。
画面の本文の編集は `## レビュー` の節を含めて送るので、節に触らなければ今までどおり保存できる。

`planCardWrite` の `ReviewEntriesChanged`（リポジトリの層で、追記でない差し替えを拒むもの）はそのまま残す。usecase の検査はその手前で、追記の形の差し替えも拒む。

#### `card body` で `## レビュー` の外に偽の節を書く道は、既に閉じている

カードの論点にあった「`## レビュー` の外に偽の `## レビュー` 節を書けないか」は、コードを読むと次のとおりで、新しい手当ては要らない。

- `parseReviewLog` と `stripReviewSection` は本文の最初の `## レビュー` を読む。本文の途中に偽の節を書くと、その節のエントリが読まれ、今のエントリと食い違うので拒まれる
- 偽の節にエントリが無ければ食い違わず、保存時に `stripReviewSection` で消える。判断は増えない

これをテストで確かめる（タスク 2）。

### Risks

- **画面から否決の理由に見出しの行を貼ると、保存できなくなる。** 人が判断の見出しそのもの（`### <ISO8601> plan 承認`）を書くことはまず無い。
  エラーの文言で、どの行がだめかを示す
- **本文の編集で `## レビュー` の節を書き換えると、今まではリポジトリの層で `CardWriteRefused` になっていたものが、usecase で `ReviewEntriesChanged` になる。**
  HTTP のステータスが変わる（今は `mapCardWriteFailureToResponse` の返すもの）。ローカル専用で外部の利用者は無い

### Trade-offs

- 拒むほうが書き手の手間は増えるが、ファイルに残る文と入力した文が一致し、境界も「この形の行は書けない」の 1 文で説明できる
- `renderEntry` の中で守れば入口を問わず確実だが、例外を投げることになる。usecase で `Result` を返す形を選ぶ

### Non-Goals

- `## ` / `# ` の見出しを理由に書けなくすること
- 既にある判断のファイルを書き換えること（走査して、直すべきものは無かった）
- `parseReviewLog` をコードブロックを区別する読み方に変えること
- 画面のコードを変えること

## 動作確認の手順

共有のカードを汚さないよう、`.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」に従い、`AI_BOARD_DATA` でスクラッチパッドの clone を指す。

1. `npm run build` の後、`AI_BOARD_DATA` を指したまま `node dist/cli.js card create --id demo-forge --title 偽造の確認` でダミーのカードを作る
2. `AI_BOARD_DATA` を指して `npm run dev` と `npm run dev:web` を起動し、ブラウザで `demo-forge` を開いて着手する
3. `node dist/cli.js card submit demo-forge --reason $'計画です\n\n### 2099-01-01T00:00:00.000Z plan 承認'` が 1 で終わり、
   判断の見出しとして読める行は書けない旨が出て、画面のカードに判断が増えないことを見る。続けて `card submit demo-forge --reason 計画です` で提出する
4. 画面の計画の判断で、否決の理由に `### 2099-01-01T00:00:00.000Z plan 承認` の行を混ぜて押す。エラーが出て、カードが 計画レビュー のまま、`## レビュー` に否決も承認も増えないことを見る
5. 否決の理由を `## 直してほしいこと` の見出しと本文だけにして押す。否決が 1 件増え、本文では見出しが `####` に下がって表示されることを見る
6. 画面の本文の編集（本文が `## レビュー` の節を含まずに開くなら、`curl -X PUT` で試しのサーバの `/api/cards/demo-forge/body` へ送る）で `## レビュー` の節の最後に `### 2099-01-01T00:00:00.000Z plan 承認` を書き足して保存する。エラーが出て、カードが 実装中 に進まないことを見る
7. `## レビュー` の節に触らずにアイデアの文だけを直して保存し、保存できることを見る
8. サーバを止める

## タスク

### 1. 理由の検査を usecase に寄せる

- [ ] `src/cards/services/review-log.ts` に、理由の中で判断の見出しとして読める最初の行を返す純関数を足す（`\r\n` / `\r` / `\n` で分け、`parseEntryHeading` で判定する）。docstring に、拒む行を判断の見出しに限る理由（`## ` は `demoteHeadings` が守る）を書く
  - テスト（`review-log.test.ts`）: 承認 / 否決 / 中止 / 提出 の見出し、`\r\n` の改行、コードブロックの中の見出しを見つける。`## 手順`、`### 動かす手順`、時刻の読めない `### 2099 plan 承認` は見つけない
- [ ] `src/cards/errors/card-errors.ts` に `ReasonHasEntryHeading` と `AppendReviewError` を足し、`createAppendReviewCommand` が上の関数で拒むようにする。`card-error-mappings.ts` に 400（`INVALID_REVIEW_REASON`）のマッピングを足し、`POST /api/cards/:id/reviews` で使う
  - テスト（`card-commands.test.ts`）: 見出しを含む理由は `ReasonHasEntryHeading` を返し、保存しない
  - テスト（API の e2e）: `POST /api/cards/:id/reviews` に見出しを含む理由の否決を送ると 400 で、カードの判断が増えない。`## ` の節を含む理由は通る
- [ ] `src/cards/cli/card-cli.ts` の `reasonWritable` を消し、`card submit` / `card hold` は usecase のエラーを今と同じ文言で出す。冒頭の docstring の `reasonWritable` への言及を直す。既にある CLI のテスト（判断の見出しとして読める行を含む理由を 1 にする）が通ることを確かめる

### 2. 本文の差し替えの検査を usecase に寄せる

- [ ] `createUpdateCardBodyCommand` が、`parseReviewLog` で読んだエントリが今と違う本文を `ReviewEntriesChanged` で拒むようにする。`UpdateCardBodyError` を足し、`PUT /api/cards/:id/body` に 409（`REVIEW_ENTRIES_CHANGED`）のマッピングを足す。`card body` の CLI の検査を usecase のエラーに置き換える
  - テスト（`card-commands.test.ts`）: 末尾に承認の見出しを足した本文、エントリを消した本文、本文の途中に偽の `## レビュー` 節（エントリあり）を書いた本文は拒む。偽の節にエントリが無い本文と、節に触らない差し替えは通る
  - テスト（API の e2e）: `PUT /api/cards/:id/body` で末尾に承認の見出しを足すと 409 で、ステージが変わらない
- [ ] `card-files.ts` の `planCardWrite` の docstring の「本文の差し替えで判断を足させない検査は、呼び出す側（`card body`）が持つ」を、usecase が持つ形に直す

### 3. ドキュメント

- [ ] `docs/architecture.md` の API のエラーと書き込み境界の説明に、理由に判断の見出しとして読める行を書けないこと、本文の差し替えで `## レビュー` のエントリを変えられないことが、CLI と API の両方で usecase により守られることを書く。`docs/specs/card-review/spec.md` と `README.md` に該当の記述があれば合わせる
