# カードの並び替えができる

## 提案

### Why

いま列の中のカードは `created` の昇順で固定されている（`FsCardRepository.findAll` の `sort`）。
どれから手を付けるかは人が決めることなのに、その判断をボード上に置く場所が無い。
並び順を人が決められるようにし、その順序を「上にあるものから着手する」という優先度として扱う。

`card-ordering`（列内でカードを並び替えられるようにする）は同じ内容の先行カードで、
「カードファイルに順序を持たせるか、別ファイルで持つか」を未決のまま残している。
本計画はその問いにも答える。

### What Changes

- カード frontmatter に任意のフィールド `rank`（数値）を足す。値が小さいほど上に並ぶ。
- `rank` が無いカードは `created` のエポックミリ秒を `rank` とみなす。
  既存のカードは書き換えずに今と同じ順で並び、移行作業は無い。
- 並び順はボード全体で 1 本の全順序とし、各列はそれを自分のカードだけに絞って表示する。
  ステージが進んでカードが列を移っても、優先度は持ち越される。
- `POST /api/cards/:id/move` を足す。入力は移動先の列でその直前・直後に来るカードの ID
  （`after` / `before`、端なら `null`）。サーバが両者の間の `rank` を計算して書く。
- UI では同じ列の中でカードをドラッグして並べ替えられるようにする。
  挿入位置は線で示す。AI の列でも並べ替えだけはできる（ステージは変わらない）。

### Impact

- `src/cards/models/card.ts` / `models/schemas/card.schema.ts` — `rank: number | null`
- `src/cards/services/card-order.ts`（新規）— 並び順の純関数
- `src/cards/repositories/fs-card.repository.ts` — ソートと serialize / parse
- `src/cards/usecases/commands/move-card.command.ts`（新規）、`errors/card-errors.ts`、
  `controllers/card.controller.ts`、`controllers/card-error-mappings.ts`、`composition.ts`
- `src/web/api.ts` / `components/Board.tsx` / `Column.tsx` / `Card.tsx` / `styles.css`
- テスト: `card-order` のユニットテスト、move コマンド、e2e
- ドキュメント: `README.md` / `CLAUDE.md` の frontmatter 例と API 表、
  `.ai-board/cards/board-loop-skill.md`（「列の上から 1 つ」を明記する）
- API 互換: `GET /api/board` の各カードに `rank` が増える。既存フィールドは変わらない。

## 設計

### Context

カードファイルは人もエージェントも直接編集してよく、サーバはファイル監視 → SSE で
ボードを再描画する。ステージは保存せず導出するため、「列」はサーバ側のどこにも
実体を持たない。列内の順序を列ごとに持とうとすると、存在しない単位に値を紐付けることになる。

ドラッグは HTML5 DnD で、今は列単位でしか `drop` を受けていない。
同じ列へのドロップは `card.stage === stage` で捨てており、
`droppableStages` が空の AI 列のカードはそもそも `draggable` でない。

### Goals / Non-Goals

**Goals:**

- 1 回の並べ替えで書き換わるカードファイルは原則 1 つだけであること
  （差分が小さく、ブランチ間で衝突しにくい）
- 既存カードの書き換えなしで導入できること
- 列をまたいでも優先度が保たれること

**Non-Goals:**

- 列をまたぐドロップで、落とした位置に挿入すること。
  列をまたぐドロップは今どおり `startedAt` の打刻だけを行い、カードは自分の `rank` の位置に並ぶ。
  2 つの書き込みを 1 操作にまとめると、片方だけ成功した状態の扱いが要るため。
- キーボードでの並べ替え（`board-keyboard` の領分）
- 絞り込み表示中の並べ替えの特別扱い（`board-search` 側で決める）

### Decisions

#### 順序はカードファイルの frontmatter に持つ

別ファイル（例: `.ai-board/order.yaml`）に ID の配列を持つ案も考えた。しかしその方法では、
どんな並べ替えも 1 つのファイルを書き換えるため、ブランチをまたぐと必ず衝突する。
しかもカードの追加・削除・リネームのたびに同期が要る。
配列に載っていないカードの扱いもどのみち決める必要がある。

frontmatter に置けば、順序は他の痕跡（`startedAt` / `## レビュー`）と同じくカードの上に残る。
「1 ファイル = 1 カード」の原則も崩れない。

#### `rank` は数値で持ち、無いときは `created` から補う

新しい `rank` は直前・直後のカードの実効値の中点にする。こうすれば書き換えるのは
動かしたカード 1 枚だけで済む。

実効値は `card.rank ?? Date.parse(card.created)` とする。
こうすると、`rank` を持たないカードは今と同じ `created` 順に並ぶ。
新しく作られたカードは既存のどのカードよりも大きい値を持つので、列の末尾に付く。
作成 API に既定値を書かせる必要がなく、エディタで手書きしたカードも同じ規則で並ぶ。

列の端へ動かすときは、隣のカードの実効値から ±1 秒（1000）ずらした値にする。

文字列の fractional index（`a0`, `a0V` …）も検討したが見送った。
依存が 1 つ増えるうえ、人がエディタで読んだときに意味が取れないためである。
数値の弱点は中点を取り続けたときの精度切れだが、エポックミリ秒の間隔は通常数分以上ある。
同じ隙間に 40 回以上続けて差し込まない限り尽きない。
尽きた場合（中点が両端のどちらかと一致した場合）は、全カードの `rank` を
現在の順序のまま 1000 刻みで振り直す。このときに限って複数のファイルを書く。
振り直した値はエポックミリ秒よりはるかに小さいため、その後に作られたカードも末尾に付く。

実効値が同じカードが並んだときは、今と同じく `id` の辞書順で決める。

#### 並び順は全カードで 1 本とし、列はその部分列を見せる

列ごとに順序を持つと、列の実体が無いことと衝突する（Context を参照）。
全体の順序で 2 枚のカードの間に差し込めば、差し込んだ列の中での相対順だけが変わり、
他の列の相対順は変わらない。カードが実装中へ進んでも、計画提案中で上にあったカードは
上にあり続ける。

#### 移動は専用のエンドポイントで、隣の ID を受け取る

`PATCH /api/cards/:id` に `rank` を足して web 側で中点を計算させる案は採らない。
中点の計算と精度切れの振り直しが web とサーバの 2 か所に分かれるからである。

`POST /api/cards/:id/move` は `{ after: CardId | null, before: CardId | null }` を受け取る。
2 つとも `null` なら何もしない（列に 1 枚しか無い）。サーバは 2 つのカードの実効値を読み、
`after < before` でなければ `StaleOrder`（409）を返す。
これは、クライアントの表示が古い（SSE の反映前に操作した）ことを意味するため、
web は再取得して終える。
隣として指定されたカードが無ければ `CardNotFound`（404）を返す。

`rank` を `PATCH` の入力には足さない。並べ替えの入口を 1 つに絞るためである。
エディタで直接書き換える経路は残る。

#### `rank` は人の領分

優先度を決めるのは `startedAt` と同じく人の判断である。エージェントは `rank` を書かず、
読むだけにする。`board-loop-skill` のハードルールにこの一行を足し、
「優先順に 1 つだけ」の「優先順」が列の上からであることも明記する。
ステージ導出（`stage-resolver.ts`）は `rank` を一切見ない。

#### UI: 同じ列へのドロップを並べ替えとして受ける

- すべてのカードを `draggable` にする。受け入れ判定は次の 2 通りに分かれる。
  同じ列なら並べ替えとして常に受ける。別の列なら今どおり `droppableStages` で決める。
- `dragover` のたびに、列内の各カードの縦の中心とポインタの Y を比べて挿入位置を決める。
  その位置に線を出す。挿入位置が元の位置と同じならドロップしても何もしない。
- ドロップしたら、表示上の新しい並びで直前・直後になったカードの ID を `move` に送る。
  楽観的に並べ替えてから、応答か SSE で正しい状態に戻す。

### Risks / Trade-offs

- エディタで `rank` を手書きした結果、同じ値のカードが並ぶことがある
  → `id` 順で決定的に並ぶ。次に動かせば解消する。
- 振り直しは全カードを書き換え、コミット差分が大きくなる
  → 起こるのは同じ隙間に数十回続けて差し込んだときだけで、実運用ではまず起きない。
- AI の列のカードが `draggable` になり、別の列へ動かせるように見える
  → 別の列の上では今どおり `rejects` の見た目を出す。

## タスク

### 1. 並び順の純関数

- [ ] 1.1 `src/cards/services/card-order.ts` に `effectiveRank(card)` と
      `compareCards(a, b)`（実効値 → `id`）を作る
- [ ] 1.2 `rankBetween(prev: number | null, next: number | null): number | null` を作る。
      端は ±1000、精度切れは `null` を返す
- [ ] 1.3 `rebalance(cards): Map<CardId, number>` を作る（現在の順序で 1000 刻み）
- [ ] 1.4 ユニットテスト: `rank` 無しが `created` 順になること、新規カードが末尾に付くこと、
      中点・両端・同値・精度切れ・振り直し後の順序保存

### 2. モデルとリポジトリ

- [ ] 2.1 `Card` と `CardFrontmatterSchema` に `rank: number | null`（任意、既定 `null`）を足す
- [ ] 2.2 `serializeCard` は `rank` が `null` のときキーを書かない
      （既存カードを保存し直しても差分を生まない）
- [ ] 2.3 `findAll` のソートを `compareCards` に差し替える
- [ ] 2.4 リポジトリのテスト: `rank` の往復、`rank` 無しファイルの保存で行が増えないこと

### 3. move コマンドと API

- [ ] 3.1 `StaleOrder` エラーを足し、`MoveCardError = CardNotFound | StaleOrder` を定義する
- [ ] 3.2 `move-card.command.ts` を作る。隣の実効値の検証、`rankBetween`、
      精度切れなら `rebalance` して再計算、変わったカードだけ `save`
- [ ] 3.3 `MoveCardInputSchema`（`after` / `before` は `CardId | null`、自分自身は不可）
- [ ] 3.4 `POST /api/cards/:id/move` を controller と `composition.ts` に配線し、
      `card-error-mappings.ts` の `switch` に 409 を足す
- [ ] 3.5 e2e: 列の先頭・中間・末尾への移動、`GET /api/board` の順序への反映、
      404 / 409 / 400

### 4. UI

- [ ] 4.1 `web/types.ts` の `BoardCard` に `rank` を、`api.ts` に `moveCard` を足す
- [ ] 4.2 `Card.tsx` を常に `draggable` にし、`Column.tsx` で
      同じ列の受け入れと挿入位置の計算・線の表示を行う
- [ ] 4.3 `Board.tsx` で同じ列へのドロップを `moveCard` に、別の列へのドロップを
      今どおり `patchForStage` に振り分ける。楽観的更新と `StaleOrder` 時の再取得
- [ ] 4.4 ブラウザで確認する: 各列での並べ替え、別の列へのドラッグが今どおり動くこと、
      エディタで `rank` を書き換えたときに SSE で反映されること

### 5. ドキュメントと仕上げ

- [ ] 5.1 `README.md` / `CLAUDE.md` の frontmatter 例に `rank` を、API 表に `move` を足す
- [ ] 5.2 `board-loop-skill.md` に「優先順は列の上から」と「`rank` を書かない」を足す
- [ ] 5.3 `npm run typecheck && npm run lint && npm test` を通す
