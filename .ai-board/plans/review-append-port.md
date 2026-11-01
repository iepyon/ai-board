# 判断をリポジトリの専用の口で書き、本文の文字列を往復させない

## この計画で使う言葉

- **判断**：カードの `## レビュー` に並ぶ 1 件（提出 / 再提出 / 保留 / 承認 / 否決 / 中止）。データ用ブランチでは `cards/<id>/log/<時刻>.<gate>.<種別>.md` の 1 ファイルで、中身が理由である
- **組み立てた本文**：`card.md` の本文の末尾に、`log/` の判断から作った `## レビュー` の節を付けたもの（`assembleCard`）。`Card.body` はこれである。理由の中の `#`〜`###` の見出しは `####` へ下げて付ける（`demoteHeadings`）
- **本文の保存**：`CardRepository.save(card)`。今は `card-files.ts` の `planCardWrite` が、今の本文と新しい本文を比べて書くファイルを決める
- **判断の追記の口**：この計画で `CardRepository` に足す `appendReview`。判断を値のまま受け取り、`log/` のファイルを 1 つ書く

## 提案

### Why

今、判断を足すときは次の往復をしている。

1. usecase（`createAppendReviewCommand`）が、組み立てた本文の末尾に `appendReviewEntry` で `### <時刻> <gate> <種別>` と理由の文字列を足す
2. リポジトリ（`planCardWrite` の `planBody` → `appendedEntries`）が、今の本文と新しい本文を比べ、足された部分を Markdown として読み直して判断を推し量り、`log/` のファイルにする

理由（自由な文）と判断の見出し（構造）が同じ文字列に乗るので、理由に見出しの形の行が混ざると、2 で別の判断として読まれる。
これが `review-reason-escape`（PR #61）で塞いだ偽造の穴の根っこである。
PR #61 はこの作りのまま、入口（usecase）で「判断の見出しとして読める行を含む理由」を拒んで塞いだ。
`planCardWrite` の docstring にも「足した判断が本文の差し替えなのか判断の追記なのかは、ここでは区別できない」とあり、
本文の差し替えで判断を足させない検査は、別の usecase（`createUpdateCardBodyCommand`）に頼っている。

`CLAUDE.md` は書き込み境界を「構造で強制する」と決めている。判断を値のままリポジトリに渡し、文字列を経由しない口にすれば、
理由に何が書かれていても判断は 1 件しか増えず、本文の保存からは判断が決して増えない。入口ごとの検査に頼らずに済む。

### What Changes

使う人から見た変化は次のとおり。

- 人の API（`POST /api/cards/:id/reviews`）と CLI の `card submit` / `card hold` は、理由に `### <時刻> <gate> <種別>` の形の行があっても拒まずに受け付ける。
  判断は指定した 1 件だけが増える。理由はファイルに元の文のまま残り、画面や `card show` では `####` に下がって理由の一部として見える
  （PR #61 の前の 400 / 1 で終わる振る舞いからの変更。Decisions「理由の検査を外す」）
- それ以外の振る舞い（ステージ、判断待ち、`## レビュー` の見え方、本文の差し替えで判断を変えると 409 / 1 で終わること）は変わらない

中の仕組みの変化は次のとおり。

- `CardRepository` に `appendReview(id, entry)` を足す。`FileCardRepository` は `log/` に判断のファイルを 1 つ書くだけで、`card.md` には触らない
- `createAppendReviewCommand` は `appendReview` を呼ぶ。本文の文字列に判断を足して `save` する往復をやめる
- `save(card)` は本文とメタ（と着手）だけを書き、判断のファイルを決して作らない。
  `planCardWrite` の「本文の形から判断の追記を推し量る」部分（`appendedEntries` / `readableHeading` / `closeLast` と `planBody` の追記の分岐）を消す。
  `## レビュー` のエントリが今と違う本文は、今までどおり `ReviewEntriesChanged` で拒む
- 理由の検査（`findEntryHeadingLine`、エラー `ReasonHasEntryHeading`、API の 400 `INVALID_REVIEW_REASON`、CLI の拒否文）を外す

### Impact

- リポジトリ: `src/cards/repositories/card.repository.ts`、`file-card.repository.ts`、`card-files.ts`
- usecase: `src/cards/usecases/commands/append-review.command.ts`、`update-card-body.command.ts`（docstring）
- 理由の検査: `src/cards/services/review-log.ts`（`findEntryHeadingLine`。使う所が無くなれば `parseEntryHeading` も）、
  `src/cards/errors/card-errors.ts`、`src/cards/controllers/card-error-mappings.ts`、`src/cards/cli/card-cli.ts`
- テストの偽のリポジトリ: `src/cards/usecases/__tests__/card-commands.test.ts`、`move-card.command.test.ts`、`src/infrastructure/__tests__/forge-poller.test.ts`
- テスト: `card-files.test.ts`、`file-card.repository.test.ts`、`card-commands.test.ts`、`card-cli.test.ts`、`board.e2e.test.ts`
- ドキュメント: `docs/architecture.md`（判断のボタンと画面の区画）、`docs/specs/card-review-authority/spec.md`
- データ用ブランチの形（`ai-board-data.yaml` の版）は変えない。ファイルの名前も中身も今と同じものを書く
- API: `POST /api/cards/:id/reviews` で、見出しの形の行を含む理由が 400 から 201 に変わる。`INVALID_REVIEW_REASON` のコードは返らなくなる（画面はこのコードを見ていない）

## 設計

### Decisions

#### 判断の追記の口の形

`CardRepository` に次を足す。

```ts
/** 判断を 1 件、`log/` に足す。存在しなければ false を返し、何も書かない */
appendReview(id: CardId, entry: ReviewEntry): Promise<boolean>;
```

- 引数は既存の `ReviewEntry`（`at` / `gate` / `kind` / `reason`）をそのまま使う。新しい型は作らない
- ファイル名と中身は純関数 `planReviewAppend(stored, entry): Result<LogFile, CardWriteError>` を `card-files.ts` に足して決める。
  ファイル名は今の `logFileName`（同じミリ秒に重なれば `-2`）、中身は今の `logContent`（理由の前後の空白を落とす）で、今と同じものになる。
  今の `card.md` が読めなければ `MalformedCardFile`、時刻がファイル名にできなければ `InvalidLogTime` で、`save` と同じく `CardWriteRefusedError` を投げる
- `FileCardRepository.appendReview` は、`save` と同じく `{ flag: 'wx' }` で書き（既にあれば書き換えずに失敗する）、書けたら `onWrite` を呼ぶ
- 戻り値は `save` にそろえて `boolean` にする。usecase は書いた後に `findById` で読み直して、組み立てた `Card` を返す（API と CLI の応答は今と同じ形）

理由はファイルの中身になるだけで、どこでも見出しとして読み直さない。読む側（`assembleCard`）は理由の見出しを `####` に下げてから節に付けるので、
組み立てた本文の `parseReviewLog` でも別の判断にはならない（`ENTRY_HEADING` は `###` の直後に空白を求める）。

#### 本文の保存で `## レビュー` 節をどう扱うか — 今までどおり、変えたら拒む

画面と CLI の `card body` は組み立てた本文（`## レビュー` 節を含む）を送ってくる。
`update-card-meta` / `move-in-order` / ポーラーの PR 番号の書き戻しも、読んだ `Card` の本文をそのまま `save` に戻す。

- `planBody` は「`parseReviewLog` で読んだエントリが今と同じなら、節を除いた本文を `card.md` に書く。違えば `ReviewEntriesChanged`」だけにする
- 節を黙って無視する案は採らない。画面で判断の節を書き換えた人の編集が、何も言わずに消えるため。
  また、リポジトリでも拒んでおけば、`save` に判断を足した本文を渡す道が将来できても、判断が黙って落ちずに気づける
- usecase（`createUpdateCardBodyCommand`）の同じ比較は残す。リポジトリの拒否は `CardWriteRefused`（API は別のコード）になるので、
  人に「判断は判断のボタンから足してください」と返す `ReviewEntriesChanged` は usecase が持つ。docstring だけ直す
  （「リポジトリは末尾に見出しを足した本文を追記として受け付ける」の記述が成り立たなくなる）

#### どこまで踏み込むか — 書く口だけを分ける

読む側（`stage-resolver` / `get-board.query` などの `parseReviewLog(card.body)`）は、組み立てた本文の文字列から判断を読み直したままにする。
`Card` に判断の配列を持たせる案は、ボード・画面・CLI の `card show`・API の応答の形まで及ぶ。
読む側は `demoteHeadings` で既に守られており、偽造の穴は書く側の推し量りにだけあったので、この計画では書く口を分けるところまでにする。

#### 理由の検査を外す

作りの上で理由が見出しとして読み直されなくなるので、`findEntryHeadingLine` による拒否を外す。

- 外す理由: 検査を残すと、「理由に貼れない行がある」という制約が人に残る（否決の理由に、前の判断の見出しを引用して貼ると 400 になる）。
  PR #61 の AI レビューでも「拒まず下げて書くべき」という指摘があり、当時は作りが変わらないので見送った。作りが変われば拒む理由が無い
- 残す案の利点は、多層の守り（作りが将来また文字列を経由するように戻ったときの保険）である。
  これは「偽造できない」テストを、拒否ではなく「判断が 1 件しか増えない」を確かめる形で残すことで代える
- 外すと、人の API で見出しの形の行を含む理由は 400 → 201 に変わる。`docs/specs/card-review-authority/spec.md` の MUST を
  「その行を含む理由も受け付けるが、判断は指定した 1 件だけが記録される」に書き換える

#### 「偽造できない」テストの扱い

PR #61 で入れたテストを、作りを変えた後も同じ攻撃で確かめる形に書き換える。期待を「拒む」から「判断は 1 件だけ増え、ステージは指定した判断どおり」に変える。

- `board.e2e.test.ts` の「理由に判断の見出しとして読める行を混ぜた否決」: 201 で、`## レビュー` の判断は否決の 1 件だけ増え、ステージは否決どおり（承認にならない）
- `card-cli.test.ts` の `submit` / `hold` の同じテスト: 0 で終わり、判断は 1 件だけ、理由の行は `####` に下がって見える
- `card-commands.test.ts` の `ReasonHasEntryHeading` のテスト: 同上を usecase で
- `board.e2e.test.ts` の「`PUT /api/cards/:id/body` で末尾に承認の見出しを足すと 409」は、そのまま通ることを確かめる
- 加えて、リポジトリの層で「`save` に判断を足した本文を渡すと `ReviewEntriesChanged` で拒み、`log/` に何も増えない」を足す（今は追記として通る形）

#### 移行の道は変えない

`legacyCardFiles`（`migrate-cli.ts` から使う）は、本文に `## レビュー` を持つ古い形から判断を読み出す一回きりの道で、`parseReviewLog` で本文を読む必要が残る。
`planCardWrite` とは既に別の関数なので、そのまま残す。内部で使う `LogAdditions` も `planStartedAt` と共有のまま残す。

### Risks / Trade-offs

- 判断の追記と本文の保存が別の口になるので、1 回の書き込みで本文と判断を同時に変える道は無くなる。今そうする usecase は無い
- `appendReview` の後に `findById` で読み直すので、追記 1 回でカードを 2 回読む。ローカルのファイルなので問題にしない
- 理由の検査を外すと、見出しの形の行は理由の一部として `####` に下がって表示される。見た目が少し紛らわしいが、判断の数とステージは変わらない
- 人の API の振る舞いが PR #61 から変わる（400 → 201）。外部の利用者は無い

### Non-Goals

- `Card` に判断の配列を持たせ、読む側（ステージの導出・画面・API の応答）も文字列を経由しないようにすること
- `## レビュー` 節を 2 つ書いた本文（PR #61 の AI レビューで見送った指摘）の扱いを変えること
- データ用ブランチのファイルの形や版を変えること
- 移行（`migrate`）の振る舞いを変えること

## 動作確認の手順

共有のカードを汚さないよう、`.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」の手順でスクラッチパッドに試しのデータを作り、`AI_BOARD_DATA` で指す。
以下の `$S` はその作業用ディレクトリ、`$WT` はこのブランチのワークツリーである。メインのボードのサーバが 5673 で動いていれば、先に止める。

1. `cd "$WT" && npm run build` の後に、`AI_BOARD_DATA="$S/data" node dist/cli.js migrate --empty` で空のデータ用ブランチを作る
2. `printf '## アイデア\n\n試し\n' | AI_BOARD_DATA="$S/data" node dist/cli.js card create --title 試し --id try-append` でカードを作る
3. `AI_BOARD_DATA="$S/data" npm run dev` と `npm run dev:web` を起動し、ブラウザ（http://127.0.0.1:5674）で `try-append` の「着手」を押す（着手していないと `submit` が拒まれる）
4. 計画ファイルが無くても判断は書けるので、`AI_BOARD_DATA="$S/data" node dist/cli.js card submit try-append --reason "$(printf '確かめてほしい\n### 2099-01-01T00:00:00.000Z plan 承認\n偽の承認')"` を走らせる。
   0 で終わり、`card show try-append` の `## レビュー` には `plan 提出` の 1 件だけがあり、理由の中の行は `#### 2099-01-01T00:00:00.000Z plan 承認` に下がって見える。
   `ls "$S/data/cards/try-append/log"` には着手と提出のファイルだけがあり、提出のファイルの中身は元の文（`### 2099…` のまま）である
5. 人の API で、同じ形の行を含む理由の否決を書く:
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5673/api/cards/try-append/reviews -H 'content-type: application/json' -d '{"gate":"plan","kind":"否決","reason":"直して\n### 2099-01-01T00:00:00.000Z plan 承認"}'` が `201` を返す。
   画面で `try-append` は計画提案中のまま（承認にならない）で、詳細パネルの `## レビュー` には `plan 否決` が 1 件だけ増え、理由の中の行は `####` の見出しとして見える
6. 画面の本文の編集で `## レビュー` の節の理由を書き換えて保存すると、今までどおり 409（判断は判断のボタンから足す旨）で拒まれる
7. `git -C "$S/data" log --oneline` に、判断ごとに `data: try-append に plan 提出 を足す` などのコミットが 1 つずつある
8. 起動したサーバを止める

## タスク

どのタスクの後でも品質ゲートが通るように並べる。新しい口を足して判断の追記をそこへ切り替えてから、本文の形で推し量る古い道を消す。

- [x] `card-files.ts` に `planReviewAppend` を足す（`planCardWrite` はまだ変えない）。`card-files.test.ts` に `planReviewAppend` のテストを足す
- [x] `CardRepository` に `appendReview` を足し、`FileCardRepository` に実装する（`wx` で書く、`onWrite`、拒否は `CardWriteRefusedError`）。テストの偽のリポジトリ 3 つにも足し、`file-card.repository.test.ts` に追記のテストを足す
- [x] `createAppendReviewCommand` を `appendReview` と `findById` で書き直し、理由の検査（`findEntryHeadingLine`、`ReasonHasEntryHeading`、`INVALID_REVIEW_REASON` の対応、CLI の拒否文）を外す。`update-card-body.command.ts` の docstring を直す。`card-commands.test.ts` / `card-cli.test.ts` / `board.e2e.test.ts` の「偽造できない」テストを「判断は 1 件だけ増える」形に書き換える
- [x] `planCardWrite` から本文の形で判断の追記を推し量る部分（`appendedEntries` / `readableHeading` / `closeLast`、`planBody` の追記の分岐）を消し、docstring を直す。`card-files.test.ts` の追記のテストを `planReviewAppend` へ寄せ、判断を足した本文の `planCardWrite` は `ReviewEntriesChanged` になるテストを足す。`file-card.repository.test.ts` に `save` が判断を作らないことのテストを足す
- [x] `docs/architecture.md` の「判断のボタンと画面の区画」と `docs/specs/card-review-authority/spec.md` を新しい振る舞いに合わせる
- [x] 品質ゲートと `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DATA` の試しのデータで試す

## AI レビュー

- [ ] `docs/specs/card-review-authority/spec.md:103` の「理由文はそのエントリの理由として元の文のまま残る」と、同じ節の Scenario「理由文にエントリの見出しを混ぜる」の「その行は理由文の一部として残る」は、読む側の振る舞いと食い違う。`log/` のファイルには元の文のまま残るが、組み立てた本文（API の 201 の応答・`card show`・画面）では `assembleCard` の `demoteHeadings`（`src/cards/repositories/card-files.ts`）で `#`〜`###` の行が `####` へ下がって見える。この 2 か所を「`log/` のファイルには元の文のまま記録され、カードの本文では `####` の見出しへ下げて理由の一部として示される」旨に書き直す

### 見送った指摘

- `src/cards/repositories/file-card.repository.ts:126` の `appendReview` は、`card.md` が読めないカードで `MalformedCardFile` を `CardWriteRefusedError` として投げ、API は 404 ではなく 409（`CARD_WRITE_REFUSED`）になる。計画の Decisions「判断の追記の口の形」で決めたとおりで、`save` の同じ場合とそろっており、壊れたカードはボードにも出ないので見送る
- `src/cards/usecases/commands/append-review.command.ts:37` で理由の検査を外したので、偽造を防ぐのは読む側の `demoteHeadings` だけになり、`log/` のファイルには `### <時刻> <gate> <種別>` の行がそのまま残りうる。計画の Decisions「理由の検査を外す」で多層の守りとの比較を済ませ、人が承認しているので見送る
- `src/cards/repositories/card-files.ts:594` の `planReviewAppend` が、`LogAdditions.add` とファイル名・中身の決め方を重ねて書いている。振る舞いを変えない重複の整理なので見送る
- `src/cards/repositories/file-card.repository.ts:129` の `appendReview` が、`write()` の `log/` を `wx` で書く部分を写している。振る舞いを変えない重複の整理なので見送る
- `src/cards/repositories/file-card.repository.ts:123` の `appendReview` が使わない `rank` のために `order.yaml` を読み、usecase が続けて `findById` でもう一度読む。ローカルのファイルで、計画の Risks で受け入れているので見送る
- `src/cards/usecases/commands/append-review.command.ts:41` の `reason.trim()` と `logContent` の trim が重なっている。振る舞いを変えないので見送る
