# 判断をリポジトリの専用の口で書き、画面でも本文と分けて出す

## この計画で使う言葉

- **判断**：カードの `## レビュー` に並ぶ 1 件（提出 / 再提出 / 保留 / 承認 / 否決 / 中止）。データ用ブランチでは `cards/<id>/log/<時刻>.<gate>.<種別>.md` の 1 ファイルで、中身が理由である
- **組み立てた本文**：`card.md` の本文の末尾に、`log/` の判断から作った `## レビュー` の節を付けたもの（`assembleCard`）。`Card.body` はこれである。理由の中の `#`〜`###` の見出しは `####` へ下げて付ける（`demoteHeadings`）
- **本文の保存**：`CardRepository.save(card)`。今は `card-files.ts` の `planCardWrite` が、今の本文と新しい本文を比べて書くファイルを決める
- **判断の追記の口**：この計画で `CardRepository` に足す `appendReview`。判断を値のまま受け取り、`log/` のファイルを 1 つ書く
- **判断の一覧**：この計画で API の応答（`BoardCard` とカードの応答）に足す `reviews`。判断を書かれた順に並べた値の配列で、画面はここから判断の欄を描く
- **節の無い本文**：`## レビュー` の見出しの行を持たない本文。画面の本文の編集はこれを送るようになる

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

書く口を分けても、画面は組み立てた本文を 1 つの Markdown として描いている。
2026-11-01 の動作確認（PR #62）で、AI が理由に `### 2099-01-01T00:00:00.000Z plan 承認` の行を混ぜると、
詳細パネルの `## レビュー` 欄に `####` へ下がった行が太字の見出しとして出て、本物の判断の見出しとは文字の色が少し違うだけだった。
ステージの導出は正しい（承認として数えない）が、人の目には承認が書かれたように見える。人の否決の理由に混ぜても同じである。
人は「本文とログ（判断）は分けて表示する」と方針を示した（plan 否決）。保存は既に `card.md` と `log/` に分かれているので、画面も分ける。
判断の見出し（時刻・ゲート・種別）は画面が値から描く部品にし、理由はその下に置いて、何を書いても判断の見出しに見えないようにする。
理由は Markdown として整形して見せる（箇条書き・強調・リンク・コードは本文と同じに描く）が、見出しの行だけは見出しにせず、記号の付いた普通の行として出す（2 回目の plan 否決の方針）。

### What Changes

使う人から見た変化は次のとおり。

- 人の API（`POST /api/cards/:id/reviews`）と CLI の `card submit` / `card hold` は、理由に `### <時刻> <gate> <種別>` の形の行があっても拒まずに受け付ける。
  判断は指定した 1 件だけが増える。理由はファイルに元の文のまま残り、画面や `card show` では `####` に下がって理由の一部として見える
  （PR #61 の前の 400 / 1 で終わる振る舞いからの変更。Decisions「理由の検査を外す」）
- 詳細パネルは本文と判断を分けて出す。本文の欄（表示と編集）には `## レビュー` の節を出さない。
  その下に「判断の記録」の欄を置き、判断を 1 件ずつ、画面が値から描いた見出し（時刻・ゲート・種別）と、その下の理由で出す。
  理由は Markdown として整形して描く（箇条書き・番号付きの手順・強調・リンク・コード）。ただし見出しの行（`#`〜`######`）だけは見出しとして描かず、
  `#### 2099-01-01T00:00:00.000Z plan 承認` のように記号の付いた普通の行として出すので、理由に何を書いても見出しにも別の判断にも見えない
- 画面の本文の編集は節の無い本文を送り、判断は変わらずに本文だけが保存される。
  CLI の `card body` と API の `PUT /api/cards/:id/body` も、節の無い本文を「判断は変えない」として受け付ける（今は判断を消したとみなして 1 / 409）
- `## レビュー` の節を持つ本文を送ったときは今までどおり、エントリが今と違えば 1 / 409 で拒む。同じなら節を除いて本文を書く
- それ以外の振る舞い（ステージ、判断待ちの区画、`card show` の `## レビュー` の見え方）は変わらない

中の仕組みの変化は次のとおり。

- `CardRepository` に `appendReview(id, entry)` を足す。`FileCardRepository` は `log/` に判断のファイルを 1 つ書くだけで、`card.md` には触らない
- `createAppendReviewCommand` は `appendReview` を呼ぶ。本文の文字列に判断を足して `save` する往復をやめる
- `save(card)` は本文とメタ（と着手）だけを書き、判断のファイルを決して作らない。
  `planCardWrite` の「本文の形から判断の追記を推し量る」部分（`appendedEntries` / `readableHeading` / `closeLast` と `planBody` の追記の分岐）を消す。
  `## レビュー` のエントリが今と違う本文は、今までどおり `ReviewEntriesChanged` で拒む
- 理由の検査（`findEntryHeadingLine`、エラー `ReasonHasEntryHeading`、API の 400 `INVALID_REVIEW_REASON`、CLI の拒否文）を外す
- 本文の保存（`planCardWrite` の `planBody`）と `createUpdateCardBodyCommand` は、節の無い本文を「判断は変えない」として扱う
- API の応答は、`body` に節を除いた本文を、`reviews` に判断の一覧を返す（`BoardCard` とカードの応答の両方）。`card show` の出力は変えない

### Impact

- リポジトリ: `src/cards/repositories/card.repository.ts`、`file-card.repository.ts`、`card-files.ts`
- usecase: `src/cards/usecases/commands/append-review.command.ts`、`update-card-body.command.ts`（docstring）
- 理由の検査: `src/cards/services/review-log.ts`（`findEntryHeadingLine`。使う所が無くなれば `parseEntryHeading` も）、
  `src/cards/errors/card-errors.ts`、`src/cards/controllers/card-error-mappings.ts`、`src/cards/cli/card-cli.ts`
- テストの偽のリポジトリ: `src/cards/usecases/__tests__/card-commands.test.ts`、`move-card.command.test.ts`、`src/infrastructure/__tests__/forge-poller.test.ts`
- テスト: `card-files.test.ts`、`file-card.repository.test.ts`、`card-commands.test.ts`、`card-cli.test.ts`、`board.e2e.test.ts`
- ドキュメント: `docs/architecture.md`（判断のボタンと画面の区画）、`docs/specs/card-review-authority/spec.md`
- データ用ブランチの形（`ai-board-data.yaml` の版）は変えない。ファイルの名前も中身も今と同じものを書く
- API: `POST /api/cards/:id/reviews` で、見出しの形の行を含む理由が 400 から 200 に変わる（この口は main でも成功に 200 を返す）。`INVALID_REVIEW_REASON` のコードは返らなくなる（画面はこのコードを見ていない）
- API の応答の形: `GET /api/board` の各カードと、カードを返す口（`PUT /api/cards/:id/body` など）の `body` から `## レビュー` の節が消え、`reviews` が足される。
  使っているのは画面だけである（CLI はリポジトリを直に読む）
- 応答の組み立て: `src/board/models/board-card.ts`（`toBoardCard`）、`src/board/usecases/queries/get-board.query.ts`、`src/cards/controllers/card.controller.ts`（`toCardResponse`）
- 画面: `src/web/types.ts`、`src/web/components/CardDetail.tsx`、`src/web/components/detail/BodyEditor.tsx`、`src/web/components/detail/BodyView.tsx`（木を描く部分を理由でも使えるようにする）、新しい `src/web/components/detail/ReviewLog.tsx`、`src/web/styles.css`
- 理由の整形: `src/shared/markdown.ts` に、見出しを普通の行に戻す `parseReasonBlocks` を足す。テストは `src/shared/__tests__/markdown.test.ts`
- テスト（画面の分け方）: `board.e2e.test.ts`（応答の `body` と `reviews`、節の無い本文の保存）、`card-files.test.ts`、`card-commands.test.ts`、`card-cli.test.ts`（節の無い本文の `card body`）
- ドキュメント（画面の分け方）: `README.md`（詳細パネル）、`docs/architecture.md`（API の応答と本文の差し替え）、`docs/specs/card-review-authority/spec.md`（「書ける主体の分離」に本文の差し替えの Scenario を足す）

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

#### 本文の保存で `## レビュー` 節をどう扱うか — 節が無ければ判断は変えない、節があって違えば拒む

画面の本文の編集は、この計画から節の無い本文を送る（Decisions「画面で本文と判断を分けて出す」）。
CLI の `card body` は、エージェントが `card show` の出力を直して送るので、節を持つ本文も来る。
`update-card-meta` / `move-in-order` / ポーラーの PR 番号の書き戻しは、読んだ `Card`（組み立てた本文）をそのまま `save` に戻す。

- 判断は `log/` にあり、本文の保存は `log/` のファイルを消さない。節の無い本文を受けても判断は消えないので、
  「節が無い＝判断は変えない」と読むのが実態に合う。今の「節が無いと判断を消したとみなして拒む」は、本文と判断が 1 つの文字列だったころの読み方である
- 節があるかは、`stripReviewSection` と同じく、`trim()` が `## レビュー` に等しい行があるかで決める（`review-log.ts` に `hasReviewSection(body)` を足す）
- `planBody` は次の 2 つだけにする
  - 節が無い: 本文をそのまま `card.md` に書く。判断は今のまま
  - 節がある: `parseReviewLog` で読んだエントリが今と同じなら、節を除いた本文を書く。違えば `ReviewEntriesChanged`
    （エントリの無い `## レビュー` の見出しだけを書いた本文も、今のエントリがあれば違うので拒む）
- 節を持つ本文で判断を変えたときに黙って無視する案は採らない。CLI で判断の節を書き換えたエージェントの編集が、何も言わずに消えるため。
  また、リポジトリでも拒んでおけば、`save` に判断を足した本文を渡す道が将来できても、判断が黙って落ちずに気づける
- usecase（`createUpdateCardBodyCommand`）も同じ 2 つの読み方にそろえる。リポジトリの拒否は `CardWriteRefused`（API は別のコード）になるので、
  人に「判断は判断のボタンから足してください」と返す `ReviewEntriesChanged` は usecase が持つ。
  保存した後は `findById` で読み直して返す（節の無い本文から作った `Card` をそのまま返すと、応答の `reviews` が空になるため）

#### どこまで踏み込むか — 書く口と、API の応答と画面を分ける。`Card` と読む側は変えない

人の方針（本文とログを分けて表示する）は、画面に届く値が分かれていれば満たせる。線は次のように引く。

- **変える:** リポジトリの書く口（`appendReview`）、本文の保存の節の読み方、API の応答（`body` と `reviews` を分ける）、詳細パネル
- **変えない:** `Card` の形（`body` は組み立てた本文のまま）、読む側（`stage-resolver` / `get-board.query` / CLI の `parseReviewLog(card.body)`）、`card show` の出力
- `Card` に判断の配列を持たせる案は、`Card` を組み立てるテストや偽のリポジトリ（10 を超える所）と、読む側のすべてに及ぶ。
  読む側は `demoteHeadings` で既に守られており（理由の行は `####` に下がり、`parseReviewLog` が別の判断として読まない）、
  画面の見え方の穴は描き方にあったので、この計画では応答を組み立てる所で分けるまでにする（Non-Goals）
- `card show` の出力は変えない。サブエージェントの手順（`board-loop` の各定義）が `## レビュー` の節を読んでいるため

#### API の応答で本文と判断を分ける

`toBoardCard`（`GET /api/board`）と `toCardResponse`（カードを返す口）は、`Card` から次を作る。

- `body`: `stripReviewSection(card.body)`。`## レビュー` の節を除いた本文
- `reviews`: `parseReviewLog(card.body)` を `{ at, gate, kind, reason }` の配列にしたもの。並びは書かれた順（`log/` の順）
- 理由は組み立てた本文から読むので、`#`〜`###` の行は `####` に下がったものになる（ファイルの元の文ではない）。
  元の文を返すには `Card` に判断の配列を持たせる必要があり、上の線の外になる。画面は理由の見出しの行を見出しとして描かないので、`####` は記号のまま見え、見出しにはならない
- `get-board.query` は既に `parseReviewLog(card.body)` を読んでいるので、その結果を `toBoardCard` に渡して読み直しを重ねない
- 型は `src/web/types.ts` の `BoardCard` に `reviews: BoardCardReview[]` を足す（`BoardCardReview` は `latestReview` と同じ形なので使い回す）

#### 画面で本文と判断を分けて出す

- `BodyEditor` は応答の `body`（節の無い本文）を表示し、編集の textarea にもそれを出す。保存はそれを送るだけで、節を足し直さない
- 新しい `ReviewLog` の部品を、詳細パネルの本文の欄の下に「判断の記録」の見出しで置く。判断が無ければ欄ごと出さない
- 1 件ごとに、見出しの行を値から描く: 時刻（`formatDateTime`）・ゲート（計画 / 動作確認）・種別。種別は承認 / 否決 / 中止 / 提出系で色を分けてよい
- 理由は Markdown として整形して描く。空なら「（理由なし）」。提出の理由は手順の箇条書きやリンク（PR の URL）を含むことが多く、文字のままでは読みにくい（2 回目の plan 否決）
- ただし見出しの行は見出しにしない。`src/shared/markdown.ts` に純関数 `parseReasonBlocks(reason): Block[]` を足す。
  `parseBlocks` の結果を辿り、`heading` のブロックを、`'#'.repeat(level) + ' ' + text` の 1 行を持つ `paragraph` に置き換える。
  リストの項目の子のブロックも同じに辿る（入れ子の中の見出しも見出しにしない）
  - `parseBlocks` に「見出しを読まない」引数を足す案は採らない。見出しの行は段落の続きを切る（`startsBlock`）ので、読み方を変えると段落の切れ目まで変わり、本文の描き方に触れる危険がある。
    木を作った後に置き換えるなら、本文の描き方（`parseBlocks`）は変わらない
  - 置き換えた行には記号（`####`）を残す。理由が組み立てた本文から来るので、見出しの形の行は必ず `####` 以上に下がっており、
    記号を残せば「理由の中に見出しの形の行がある」ことが人に見え、判断の見出し（画面が値から描く部品）と取り違えない
  - 行の中の強調やリンクは、普通の段落と同じく `parseInline` で描く。強調で太字にはなるが、見出しの大きさや余白にはならない
- `BodyView` の、ブロックの木を要素に写す部分（`BlockView` とその下）を、木を受け取る部品として理由でも使えるようにする。
  `ReviewLog` は `parseReasonBlocks` の木をそこへ渡す。HTML の文字列を作らない作り（文字は React のテキストとして渡る）はそのまま
- 判断待ちの区画の札は今のまま理由を文字で出す（Non-Goals）
- 判断のボタン（`ReviewActions`）の位置は変えない

#### 理由の検査を外す

作りの上で理由が見出しとして読み直されなくなるので、`findEntryHeadingLine` による拒否を外す。

- 外す理由: 検査を残すと、「理由に貼れない行がある」という制約が人に残る（否決の理由に、前の判断の見出しを引用して貼ると 400 になる）。
  PR #61 の AI レビューでも「拒まず下げて書くべき」という指摘があり、当時は作りが変わらないので見送った。作りが変われば拒む理由が無い
- 残す案の利点は、多層の守り（作りが将来また文字列を経由するように戻ったときの保険）である。
  これは「偽造できない」テストを、拒否ではなく「判断が 1 件しか増えない」を確かめる形で残すことで代える
- 外すと、人の API で見出しの形の行を含む理由は 400 → 200 に変わる。`docs/specs/card-review-authority/spec.md` の MUST を
  「その行を含む理由も受け付けるが、判断は指定した 1 件だけが記録される」に書き換える

#### 「偽造できない」テストの扱い

PR #61 で入れたテストを、作りを変えた後も同じ攻撃で確かめる形に書き換える。期待を「拒む」から「判断は 1 件だけ増え、ステージは指定した判断どおり」に変える。

- `board.e2e.test.ts` の「理由に判断の見出しとして読める行を混ぜた否決」: 200 で、`## レビュー` の判断は否決の 1 件だけ増え、ステージは否決どおり（承認にならない）
- `card-cli.test.ts` の `submit` / `hold` の同じテスト: 0 で終わり、判断は 1 件だけ、理由の行は `####` に下がって見える
- `card-commands.test.ts` の `ReasonHasEntryHeading` のテスト: 同上を usecase で
- `board.e2e.test.ts` の「`PUT /api/cards/:id/body` で末尾に承認の見出しを足すと 409」は、そのまま通ることを確かめる
- 加えて、リポジトリの層で「`save` に判断を足した本文を渡すと `ReviewEntriesChanged` で拒み、`log/` に何も増えない」を足す（今は追記として通る形）

#### 移行の道は変えない

`legacyCardFiles`（`migrate-cli.ts` から使う）は、本文に `## レビュー` を持つ古い形から判断を読み出す一回きりの道で、`parseReviewLog` で本文を読む必要が残る。
`planCardWrite` とは既に別の関数なので、そのまま残す。内部で使う `LogAdditions` も `planStartedAt` と共有のまま残す。

### 前の実装の扱い（計画から立て直す）

このブランチには、否決の前の計画（書く口だけを分ける）の実装が既にある（`df2f21b`〜`9f0f067`）。人は動作確認の後に計画から立て直させた。

- **残す:** `planReviewAppend` と `appendReview`、`createAppendReviewCommand` の切り替え、理由の検査の撤去、`planCardWrite` の推し量りの撤去、
  「判断は 1 件だけ増える」形に書き換えたテスト、`docs/specs/card-review-authority/spec.md` と `docs/architecture.md` の判断の追記の記述。
  どれも新しい計画の Decisions と食い違わない
- **変える:** `planBody` と `createUpdateCardBodyCommand` の「節が無いと判断を消したとみなす」読み方（Decisions「本文の保存で `## レビュー` 節をどう扱うか」）。
  前の実装で足した「`save` に判断を足した本文を渡すと `ReviewEntriesChanged`」のテストは、節がある場合のテストとして残る
- **捨てるものは無い。** 前の実装の上に、節の無い本文の扱い・API の応答の分け方・詳細パネルの分け方を積む
- 2 回目の plan 否決（理由は Markdown として整形し、見出しの行だけは見出しにしない）は、1 回目の立て直しの後、まだ実装していない詳細パネルのタスクだけに関わる。
  `[x]` のタスクはどれも理由の描き方に触れていないので、外すものは無い。理由の整形のタスクを詳細パネルのタスクの手前に足した

### Risks / Trade-offs

- 判断の追記と本文の保存が別の口になるので、1 回の書き込みで本文と判断を同時に変える道は無くなる。今そうする usecase は無い
- `appendReview` の後に `findById` で読み直すので、追記 1 回でカードを 2 回読む。ローカルのファイルなので問題にしない
- 理由の検査を外すと、見出しの形の行は理由の一部として `####` に下がって残る。詳細パネルでは見出しにしない普通の行として出るので見出しには見えないが、
  `card show` では `####` の見出しとして読める。判断の数とステージは変わらない
- 理由の中の見出しの行は、書いた人が見出しのつもりでも普通の行（`#### …` と記号付き）として出る。判断の見出しに見える道を作りの上で無くすほうを採る
- 理由の強調（`**…**`）は太字で描くので、1 行を丸ごと太字にすれば見出しに近い見た目は作れる。ただし見出しの大きさ・余白・色にはならず、
  判断の見出しは画面が値から描く別の部品（時刻・ゲート・種別の並び）なので、取り違えるほどには似ない。強調まで落とすと理由が読みにくくなるので、ここで止める
- 応答の `reviews` の理由は組み立てた本文から読むので、`log/` の元の文ではなく `####` に下がった文になる（Decisions「API の応答で本文と判断を分ける」）
- 節の無い本文を「判断は変えない」と読むので、CLI で `## レビュー` の節ごと消して `card body` に送っても、拒まれずに本文だけが書かれる。
  判断は `log/` に残り消えないので、失うものは無い
- API の応答の `body` の形が変わる（節が無くなる）。使っているのは画面だけで、画面も同じ PR で直す
- 人の API の振る舞いが PR #61 から変わる（400 → 200）。外部の利用者は無い

### Non-Goals

- `Card` に判断の配列を持たせ、読む側（ステージの導出・`get-board.query`・CLI）も文字列を経由しないようにすること。
  画面に届く値は応答を組み立てる所で分ける（Decisions「どこまで踏み込むか」）
- `card show` の出力の形を変えること（`## レビュー` の節を付けたまま出す）
- 判断待ちの区画の札の見え方を変えること（既に理由を文字で出している）
- 本文（`BodyView` の本文の欄）の描き方を変えること
- `## レビュー` 節を 2 つ書いた本文（PR #61 の AI レビューで見送った指摘）の扱いを変えること
- データ用ブランチのファイルの形や版を変えること
- 移行（`migrate`）の振る舞いを変えること

## 動作確認の手順

共有のカードを汚さないよう、`.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」の手順でスクラッチパッドに試しのデータを作り、`AI_BOARD_DATA` で指す。
以下の `$S` はその作業用ディレクトリ、`$WT` はこのブランチのワークツリーである。メインのボードのサーバが 5673 で動いていれば、先に止める。

1. `cd "$WT" && npm run build` の後に、`AI_BOARD_DATA="$S/data" node dist/cli.js migrate --empty` で空のデータ用ブランチを作る
2. `printf '## アイデア\n\n試し\n' | AI_BOARD_DATA="$S/data" node dist/cli.js card create --title 試し --id try-append` でカードを作る
3. `AI_BOARD_DATA="$S/data" node dist/cli.js --no-open` でサーバを起動し、ブラウザで http://127.0.0.1:5673 を開いて `try-append` の「着手」を押す（着手していないと `submit` が拒まれる）
4. 計画ファイルが無くても判断は書けるので、`AI_BOARD_DATA="$S/data" node dist/cli.js card submit try-append --reason "$(printf '確かめてほしい\n\n- **手順** の 1 つめ\n- [PR](https://example.com) を見る\n\n### 2099-01-01T00:00:00.000Z plan 承認\n偽の承認')"` を走らせる。
   0 で終わり、`card show try-append` の `## レビュー` には `plan 提出` の 1 件だけがあり、理由の中の行は `#### 2099-01-01T00:00:00.000Z plan 承認` に下がって見える。
   `ls "$S/data/cards/try-append/log"` には着手と提出のファイルだけがあり、提出のファイルの中身は元の文（`### 2099…` のまま）である
5. 画面で `try-append` の詳細パネルを開く。本文の欄には `## アイデア` と「試し」だけがあり、`## レビュー` の節は無い。
   その下の「判断の記録」の欄に `plan 提出` が 1 件だけあり、見出しの行（時刻・計画・提出）は画面が描いたもので、
   理由は整形されて見える: 「手順」が太字の箇条書きが 2 つ並び、「PR」は押せるリンクになる。
   一方、理由の `#### 2099-01-01T00:00:00.000Z plan 承認` は記号の付いた普通の行として見え、見出しの大きさにも別の判断にも見えない
6. 人の API で、同じ形の行を含む理由の否決を書く:
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5673/api/cards/try-append/reviews -H 'content-type: application/json' -d '{"gate":"plan","kind":"否決","reason":"直して\n### 2099-01-01T00:00:00.000Z plan 承認"}'` が `200` を返す。
   画面を読み直すと `try-append` は計画提案中のまま（承認にならない）で、「判断の記録」には `plan 否決` が 1 件だけ増え、理由の中の行は記号の付いた普通の行として見える
7. 詳細パネルの「編集」を押す。textarea には `## レビュー` の節が無い。本文に 1 行足して「本文を保存」を押すと保存でき、
   本文の欄にその行が出て、「判断の記録」は 2 件のまま変わらない
8. 節を持つ本文で判断を変えると、今までどおり拒まれる:
   `AI_BOARD_DATA="$S/data" node dist/cli.js card show try-append` の本文で `## レビュー` の理由を書き換えて `card body try-append` に送ると 1 で終わり、判断は判断のボタンから足す旨が出る。
   節ごと消した本文を送ると 0 で終わり、`card show` の `## レビュー` は 2 件のまま残る
9. `git -C "$S/data" log --oneline` に、判断ごとに `data: try-append に plan 提出 を足す` などのコミットが 1 つずつある
10. 起動したサーバを止める

## タスク

どのタスクの後でも品質ゲートが通るように並べる。新しい口を足して判断の追記をそこへ切り替えてから、本文の形で推し量る古い道を消す。
その上に、節の無い本文の保存 → API の応答の分け方 → 詳細パネルの分け方の順で積む。

- [x] `card-files.ts` に `planReviewAppend` を足す（`planCardWrite` はまだ変えない）。`card-files.test.ts` に `planReviewAppend` のテストを足す
- [x] `CardRepository` に `appendReview` を足し、`FileCardRepository` に実装する（`wx` で書く、`onWrite`、拒否は `CardWriteRefusedError`）。テストの偽のリポジトリ 3 つにも足し、`file-card.repository.test.ts` に追記のテストを足す
- [x] `createAppendReviewCommand` を `appendReview` と `findById` で書き直し、理由の検査（`findEntryHeadingLine`、`ReasonHasEntryHeading`、`INVALID_REVIEW_REASON` の対応、CLI の拒否文）を外す。`update-card-body.command.ts` の docstring を直す。`card-commands.test.ts` / `card-cli.test.ts` / `board.e2e.test.ts` の「偽造できない」テストを「判断は 1 件だけ増える」形に書き換える
- [x] `planCardWrite` から本文の形で判断の追記を推し量る部分（`appendedEntries` / `readableHeading` / `closeLast`、`planBody` の追記の分岐）を消し、docstring を直す。`card-files.test.ts` の追記のテストを `planReviewAppend` へ寄せ、判断を足した本文の `planCardWrite` は `ReviewEntriesChanged` になるテストを足す。`file-card.repository.test.ts` に `save` が判断を作らないことのテストを足す
- [x] `docs/architecture.md` の「判断のボタンと画面の区画」と `docs/specs/card-review-authority/spec.md` を新しい振る舞いに合わせる
- [x] `review-log.ts` に `hasReviewSection` を足し、`planBody` と `createUpdateCardBodyCommand` を「節が無ければ判断は変えない、節があって違えば `ReviewEntriesChanged`」に変える。usecase は保存の後に `findById` で読み直して返す。docstring を直す。テストを足す: `card-files.test.ts`（節の無い本文の `planCardWrite` は判断を足さずに本文だけを書く）、`card-commands.test.ts`（節の無い本文で判断が残る）、`card-cli.test.ts`（節の無い本文の `card body` が 0 で終わり判断が残る）、`board.e2e.test.ts`（節の無い本文の `PUT /api/cards/:id/body` が 200 で判断が残る。末尾に承認の見出しを足す 409 はそのまま）
- [x] `toBoardCard` と `toCardResponse` で、`body` を `stripReviewSection` した本文に、`reviews` を `parseReviewLog` の配列にする。`get-board.query` は読んだエントリを `toBoardCard` に渡す。`src/web/types.ts` の `BoardCard` に `reviews` を足す。`board.e2e.test.ts` で、`GET /api/board` と `PUT /api/cards/:id/body` の応答の `body` に `## レビュー` が無く、`reviews` に判断が書かれた順で並ぶことを確かめる（`body` に `## レビュー` を期待している既存のテストは `reviews` を見る形に直す）
- [x] `src/shared/markdown.ts` に `parseReasonBlocks` を足す（`parseBlocks` の木の `heading` を、記号付きの 1 行の `paragraph` に置き換える。リストの項目の子も辿る）。`markdown.test.ts` にテストを足す: 見出しの行が `####` の記号を残した段落になる、箇条書き・強調・リンク・コードはそのまま、リストの中の見出しも段落になる、`parseBlocks` の結果（本文の描き方）は変わらない
- [x] 詳細パネルに `src/web/components/detail/ReviewLog.tsx` を足し、本文の欄の下に「判断の記録」を出す（見出しの行は値から描き、理由は `parseReasonBlocks` の木を Markdown として描く。空の理由は「（理由なし）」。判断が無ければ欄ごと出さない）。`BodyView.tsx` の木を要素に写す部分を理由でも使えるように切り出す。`BodyEditor` は節の無い `body` を表示・編集する（応答の形が変わるだけなので、組み立て直しはしない）。`styles.css` に欄の見た目を足す。描き方の判断（種別の色の分け方など）を純関数にするなら `src/shared/` に置いてテストする
- [x] `README.md` の詳細パネルの説明、`docs/architecture.md` の API の応答と本文の差し替えの記述、`docs/specs/card-review-authority/spec.md` の「書ける主体の分離」（本文の差し替えは判断を足さない。節の無い本文は判断を変えず、節があってエントリが違えば拒む、の Scenario を足す）を新しい振る舞いに合わせる
- [x] 品質ゲートと `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DATA` の試しのデータで試す（画面の手順 5・7 はブラウザで見る）

## AI レビュー

### 見送った指摘

- `src/board/models/board-card.ts:156` と `src/cards/controllers/card.controller.ts:45` の `reviews` は組み立てた本文から読み直すので、理由の `#`〜`###` の見出しの段の違いが `####` にそろって失われる。計画の Decisions「API の応答で本文と判断を分ける」と Risks で受け入れた振る舞いで、元の文を返すのは Non-Goals（`Card` に判断の配列を持たせる）に当たるので見送る
- `src/cards/usecases/commands/update-card-body.command.ts:47` は、判断の無いカードの本文に人が `## レビュー` の見出しの行（コードブロックの中を含む）を書くと、保存時に次の `## ` の手前まで黙って消す。判断があるカードでは `REVIEW_ENTRIES_CHANGED` になり、文言が実際の操作と合わない。main の `planBody` も同じく `stripReviewSection` で消しており、この PR で入った振る舞いではない（docstring にも書かれている）。計画の Non-Goals（`## レビュー` 節を 2 つ書いた本文の扱いを変えない）の近くにあるので見送る
- `src/cards/controllers/card.controller.ts:45` の `toCardResponse` が、`board-card.ts` の `toBoardCardReview` と同じ写し方を書き直している。振る舞いを変えない重複なので見送る
- `src/cards/repositories/card-files.ts:592` の `planReviewAppend` が `LogAdditions.add` と同じファイル名の決め方（連番・`InvalidLogTime`・`logContent`）を持ち、`src/cards/repositories/file-card.repository.ts:119` の `appendReview` が `write()` の `log/` の書き方（`mkdirSync`・`wx`・`onWrite`）を写している。振る舞いを変えない重複なので見送る
- `src/cards/usecases/commands/update-card-body.command.ts:48` の「節があってエントリが違えば拒む」が `card-files.ts` の `planBody` と 2 か所にある。今は同じ読み方で、振る舞いを変えない重複なので見送る
- 本文の保存と判断の追記の後の `findById` での読み直し、`get-board.query` での組み立てた本文の繰り返しの解析で、同じカードを何度も読む・解析する。ローカルのファイルで計画の Risks に書いた範囲であり、性能の改善はこの PR の目的の外なので見送る
- `src/shared/review-labels.ts` の `ReviewLabelGate` / `ReviewLabelKind` が `src/web/types.ts` の型を写している。書き方の好みなので見送る
