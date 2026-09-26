# アイデアの表に区切り線を置く

## 提案

### Why

アイデアの表は `rank` 順の 1 本の並びしかない。
「すぐ着手したい」ものと「後で考える」ものが同じ並びに混ざり、どこまでが次の候補なのかが画面から読めない。

アイデアの表に区切り線を 1 本置けるようにする。
線より上を「次にやる」、下を「あとで考える」と読む。
区分という新しい値は持たず、`rank` の並びの中の位置だけで表す。

### What Changes

- アイデアの表に区切り線の行を 1 本出す。線の上に「次にやる」、下に「あとで考える」の見出しを付ける。
- 区切り線はカードの行と同じくドラッグで動かせる。カードをドラッグして線をまたげば区分が変わる。
- 区切り線の位置を DB に保存する（マイグレーション v4）。
- API
  - `GET /api/board` に `ideaDivider`（区切り線の rank。未設定なら `null`）を足す。
  - `POST /api/idea-divider/move`（新規）— 区切り線を直前・直後のカードの間へ動かす。
  - `POST /api/cards/:id/move` の `after` / `before` に、カード ID の代わりに区切り線を指す値 `":divider"` を受ける。
- `ai-board card` の CLI には区切り線を読み書きする入口を作らない。

### Impact

- server
  - `src/infrastructure/database.ts` — マイグレーション v4（`idea_divider` テーブル）
  - `src/cards/repositories/`（新規）— `IdeaDividerRepository` と SQLite 実装。書き込み後に `onWrite` を呼ぶ
  - `src/cards/services/card-order.ts` — `rebalance` が区切り線を含めて振り直せるようにする
  - `src/cards/usecases/commands/move-card.command.ts` — 隣が区切り線のとき、その rank を使う
  - `src/cards/usecases/commands/move-idea-divider.command.ts`（新規）
  - `src/cards/models/schemas/card.schema.ts` / `controllers/` / `composition.ts`
  - `src/board/usecases/queries/get-board.query.ts` — `ideaDivider` を返す
- shared
  - `src/shared/dashboard-sections.ts` — アイデアを区切り線で 2 つに分ける純関数
  - `src/shared/card-reorder.ts` — 区切り線を表す定数（`DIVIDER_ID`）
- web
  - `src/web/components/dashboard/IdeaTable.tsx` — 区切り線の行、見出し、ドラッグ
  - `src/web/api.ts` / `types.ts` / `App.tsx` / `styles.css`
- テスト: `card-order`、`move-card`、`move-idea-divider`、`dashboard-sections`、マイグレーション、`board.e2e`
- ドキュメント: `README.md` / `CLAUDE.md` の API 表と書き込み境界の表
- API 互換: フィールドとエンドポイントが増えるだけで、既存の形は変わらない

## 設計

### Context

並び順は全カードで 1 本の `rank`（未設定なら `created` のエポックミリ秒）で決まり、アイデアの表はその部分列である。
並べ替えは直前・直後のカードの間の値（`rankBetween`）を書き、隙間が尽きたときだけ全カードを振り直す（`rebalance`）。

区切り線を「この rank の値の位置」として持てば、同じ並びの中に置ける。
カードの `rank` を読み比べるだけで線の上か下かが決まり、カード側に値を足す必要が無い。

### Goals / Non-Goals

**Goals:**

- アイデアの表で、次にやるものとあとで考えるものが一目で分かれること
- 区分を変える操作が、今の並べ替えのドラッグと同じ 1 動作で済むこと
- ステージの導出と、エージェントの書き込み境界を変えないこと

**Non-Goals:**

- 区切り線を 2 本以上置く（P0 / P1 / P2 のような多段）。需要が出たら別カードにする
- 区分をステージの導出やエージェントの着手判断に使う
- `card list` / `card show` への区分の表示

### Decisions

- **区切り線の位置は rank の値として保存する。**
  専用のテーブル `idea_divider (id INTEGER PRIMARY KEY CHECK (id = 1), rank REAL NOT NULL)` に 1 行だけ持つ。
  - 「上から N 件」で持つ案は採らない。上のアイデアに着手して表から消えると、下のアイデアが黙って「次にやる」へ繰り上がる。
  - 「このカードの直後」で持つ案も採らない。そのカードに着手すると基準が消える。
  - rank の値なら、カードが表から抜けても線の位置は変わらない。
- **判定は `effectiveRank(card) < ideaDivider` で「次にやる」。** 同じ値は起きないように書く（`rankBetween` は両端と一致しない値を返す）。
- **未設定（`null`）のときは、区切り線を表の末尾に出す。** すべてのアイデアが「次にやる」に入り、今の見え方と変わらない。
  区切り線を初めて動かしたときに行が作られる。
- **新しく起票したアイデアは「あとで考える」に入る。** `rank` の無いカードは作成時刻で並ぶので、区切り線より後ろに付く。
  区切り線を末尾へ動かした場合でも値は「その時点の末尾 + `RANK_STEP`」なので、それより後に作ったカードは線の下に付く。
- **区切り線は並べ替えの中では「カードと同じ 1 項目」として扱う。**
  - web は、アイデアの ID の並びに `DIVIDER_ID` を差し込んだ並びで `moveTargetFor` / `applyMove` を使う。今の関数をそのまま使える。
  - カードを動かすときの隣が区切り線なら `after` / `before` に `":divider"` を送る。`:` はカード ID に使えない文字なので衝突しない。
  - 区切り線を動かすときは `POST /api/idea-divider/move` に隣のカード ID を送る。
  - 振り直し（`rebalance`）では区切り線も 1 項目として並べ、カードと一緒に値を振り直す。
    区切り線を含めずに振り直すと、線の上下が入れ替わる。
- **区切り線を書くのはサーバ（画面の操作）だけ。** `rank` と同じく人が決める優先度なので、`ai-board card` に入口を作らない。
  CLAUDE.md の書き込み境界の表にも書く。
- **絞り込み中は区切り線を出さない。** 並べ替えも受けない（今と同じ）。見えていないカードとの位置関係が分からないため。

### Risks / Trade-offs

- move の隣に `":divider"` という特別な値が混ざる → 検証は Zod スキーマの union に閉じる。
  ユースケースでは区切り線をカードと同じ 1 項目として並びに入れ（`move-in-order.ts`）、隣の解決に特別扱いの `if` を増やさない。
- 区切り線が未設定のまま隣に指定された → 画面で見えている位置（全カードの末尾）に置いてから動かす。
  端（`null`）として扱うと、末尾の区切り線の下へカードをドラッグしても何も起きない。
- `src/web/` はテストの対象外 → 線の上下への振り分けを `dashboard-sections.ts` に置き、そこにテストを書く。

## タスク

### 1. 保存先

- [x] 1.1 `database.ts` にマイグレーション v4（`idea_divider` テーブル）を足し、テストを書く
- [x] 1.2 `IdeaDividerRepository`（`get` / `set`）と SQLite 実装を書く。書き込み後に `onWrite` を呼ぶ。テストを書く

### 2. 並べ替え

- [x] 2.1 `card-order.ts` の `rebalance` が区切り線を含めて振り直せるようにし、テストを足す
- [x] 2.2 `move-card.command.ts` で隣に区切り線を受ける。振り直し時は区切り線も書く。テストを足す
- [x] 2.3 `move-idea-divider.command.ts` を書き、テストを書く
- [x] 2.4 スキーマ・controller・エラーのマッピング・`composition.ts` を配線し、`POST /api/idea-divider/move` を足す

### 3. ボード

- [x] 3.1 `get-board.query.ts` で `ideaDivider` を返す
- [x] 3.2 `dashboard-sections.ts` にアイデアを区切り線で分ける関数を書き、テストを書く（未設定、同じ区画での境界値）
- [x] 3.3 `board.e2e.test.ts` で `ideaDivider` と 2 つのエンドポイントを検証する

### 4. 画面

- [x] 4.1 `types.ts` / `api.ts` に `ideaDivider` と区切り線の移動を足す
- [x] 4.2 `IdeaTable.tsx` に区切り線の行と見出しを出し、カードと区切り線の両方をドラッグで動かせるようにする（先行表示と 409 の巻き戻しは今と同じ）
- [x] 4.3 `styles.css` に区切り線の行のスタイルを足す（ライト / ダーク）

### 5. 仕上げ

- [x] 5.1 `README.md` / `CLAUDE.md` の API 表と書き込み境界の表を直す
- [x] 5.2 `npm run typecheck && npm run lint && npm test` を通す
- [ ] 5.3 `npm run dev` と `npm run dev:web` で実際の画面を確かめる（ドラッグ、ライト / ダーク）
