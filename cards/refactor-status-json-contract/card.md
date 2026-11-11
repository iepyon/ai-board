---
id: refactor-status-json-contract
title: 'リファクタリング: ユーザは、status --json の出す形を内部のモデルと切り離して固め、スキルやページや画面を知らないうちに壊したくない'
created: '2026-11-11T06:47:24.669Z'
skipGates: []
branch: null
pr: null
---

## アイデア

スキルが `ai-board status --json --only <項目,...>` で指している項目が `status` の出力から消えたり名前が変わったりしたら、テストで落ちるようにする（案 5）。`status` の本体（`--only` の検査・出力の形）は変えない。

- **スキルの `--only` を集める。** テストで `.claude/skills/**/*.md` と `.claude/agents/**/*.md` を読み、`status ... --only <値>` の `<値>` をすべて抜き出す。今は 4 種類ある（`next,waiting,forge,loop` / `next,loop` / `forge` / `waiting,ideas,cards.id,cards.title,cards.stage,cards.skipGates,cards.latestReview,cards.prState`）
- **試しのボードで実際に走らせる。** 抜き出した値ごとに、`status-cli.test.ts` と同じ形の試しのボード（カードが 1 枚以上ある）で `status --json --only <値>` を走らせる。
  - 終了コードが 0 であること（最上位の項目の打ち間違いや消えた項目は、今の `parseOnly` が使い方を出して 1 で落とす）
  - `<key>.<field>` の形で指した項目が、`<key>` の要素の出力にキーとして入っていること。カードの要素はどの項目も必ずキーを持つ（値が null でもキーはある）ので、カードが 1 枚あれば確かめられる。
    今の `pickFields` は無い `<field>` を黙って出さないので、ここで初めて気付ける
- **抜き出しが空でないことも確かめる。** スキルの書き方が変わって 1 件も抜き出せなくなったら、テストが何も確かめずに通ってしまうので、少なくとも 1 件あることを確かめる
- **置き場所。** `.claude/settings.json` を読むテスト（`src/__tests__/claude-settings.test.ts`）と同じく、`src/__tests__/` に置く
- **出力と `--only` の振る舞いは変えない。**

## 背景

画面とサーバは ADR 0017 でいったん外したが、後で React の画面とバックエンドを戻す予定である。`status --json` を読む側は既にあり（`board-loop` / `board-decide` のスキルと `board-view` の `render.mjs`）、React の画面が加わる。
内部のモデルはリファクタリングのたびに変わり、そのたびに出力も変わるが、出力の形を決めているものが無いので、テストでは気付けない。
とくに `--only` は入れ子の項目名を検査しない（`src/board/cli/status-cli.ts` の `parseOnly` / `pickFields`）。内部で `latestReview` の名前を変えると、`board-decide` の `--only cards.latestReview` はエラーにならず項目が消えるだけで、スキルは「判断が無いカード」と黙って読み違える。
2026-11-11 に、外に出す形を守る案を比べた（下の論点）。そのうえで人が「案 5 だけ」と決めた。スキルの `--only` という、今いちばん壊れると気付きにくい読み方だけを、テストで止める。

## 論点

- **抜き出し方。** Markdown の中のコードブロックとインラインの両方から、`--only` の直後の値を正規表現で抜く。値の中に `$` などの変数が入る書き方が出てきたら、その行は飛ばすか落とすか
- **試しのボードの中身。** カードが 1 枚あれば `cards.<field>` は確かめられる。`waiting` などの要素の項目を `--only` で指すスキルが出てきたら、その区画にもカードが要る（今は無い）
- **選ばなかった案（2026-11-11 に比べたもの）。** どれも、React を戻して画面がどの項目を要るかが見えたときに改めて決める
  - 案 1. 要素の型ごとに項目名の一覧を `satisfies Record<keyof T, true>` で書き、テストで固定して、`--only` の検査にも使う（C と D）。守れるのは 1 段目だけ
  - 案 2. 外に出す形（`StatusReport`）を入れ子まで Zod で書き、出力を `strict` で parse する。入れ子まで守れて React も使えるが、約 60 項目の二重の定義になる
  - 案 3. 試しのボードの出力から値を型の名前に置き換えた「形」を抜き、スナップショットで固定する。入れ子まで守れるが、null になりうる項目を全部埋めた試しのボードが要る
  - 案 4. 型から JSON Schema を生成してコミットする。新しい依存と生成の手順が要る
  - 内部のモデル（`BoardCard` など）を Zod で書き、出力をモデルのまま出す案は、内部の名前を変えるとそのまま外も変わるので選ばない
- **守れないもの。** `--only` を使わずに中身を読む深い項目（`board-decide` の `prState.webUrl`・`latestReview.reason`、`board-loop` の `next.step`・`loop.running[].loop`、`render.mjs` の `waiting[].decisions` など）は、このカードでは守らない
- **タイトル。** タイトルは「出す形を内部のモデルと切り離して固め」だが、このカードでは切り離さず、スキルの `--only` が壊れたらテストで止めるところまでにした
