# テストも型検査にかけ、テスト用の値が本体の型とずれたら品質ゲートで落とす

## 人に判断してほしいこと

- なし

## 提案

### Why

`tsconfig.json` は `**/__tests__/**` を除外し、vitest は型を見ずにテストを走らせる。そのため `src/shared/` の外のテストは、型検査を一度も通っていない。
今の main でテストまで含めて `tsc` をかけると 40 件落ちる（カードを書いた 2026-10-23 は 7 件）。
どれも、本体に項目を足したり形を変えたりしたときに、テスト用の値が追従していないものである。テストは通っているが、テストが本当の形のデータを検査しなくなっていく。

`forge-card-error` では、止まりの入力に `mrFailure` を足したのに `next-action.test.ts` の値が古いままでも型検査が通った。
一方 `src/shared/` のテストは `tsconfig.web.json` が丸ごと含むので、同じ変更ですぐに落ちた。全部のテストを後者の側にそろえる。

### What Changes

- `tsconfig.test.json` を足す。`tsconfig.json` を継ぎ、`__tests__` を除外しない（`src/web/` は今までどおり除く）。出力はしない
- `npm run typecheck` が 3 本目の `tsc --noEmit -p tsconfig.test.json` を走らせる。CI（Linux と Windows の両方の行）は `npm run typecheck` を呼んでいるので、そのまま乗る
- 今の 40 件の型エラーを直す。テストの振る舞いは変えない
- README の品質ゲートの説明に、テストも型検査に入ることを書く

### Impact

- 設定: `tsconfig.test.json`（新規）、`package.json`（`typecheck`）
- テスト: `src/infrastructure/__tests__/forge-poller.test.ts`、`src/board/controllers/__tests__/board.e2e.test.ts`、`src/board/services/__tests__/stage-resolver.test.ts`、
  `src/cards/usecases/__tests__/card-commands.test.ts`、`src/infrastructure/__tests__/cli-runner.test.ts`、`src/cards/__tests__/composition.test.ts`、`src/board/cli/__tests__/status-html.test.ts`
- ドキュメント: `README.md`（品質ゲートの節）
- 本体のコード・ビルド（`tsconfig.json` の出力）・ESLint の設定: 変わらない

## 設計

### Decisions

- `tsconfig.test.json` は次の形にする

  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": { "noEmit": true },
    "exclude": ["src/web/**", "node_modules", "dist"]
  }
  ```

  `include` は `tsconfig.json` の `src/**/*.ts` を継ぐ。`exclude` を上書きして `**/__tests__/**` を外す

- `package.json` の `typecheck` は `tsc --noEmit && tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.test.json` にする
- 型エラーの直し方は、テストの値を今の型に合わせることを基本にする
  - 本体に足された項目が無い値（`latestAiNoteAt`・`draft`・`httpStatus` など）: 項目を足す。値はテストの意図に合わせる（多くは `null` / `false`）
  - 形が変わった値（`stage-resolver.test.ts` の `Card` / `PlanDoc` / `MrState`、`forge-poller.test.ts` の `makeCard` など）: 今の型の形に書き直す
  - `vi.fn()` を型の付いた口（`onUpdate: () => void` など）に渡すところ: `vi.fn<() => void>()` のように型引数を付ける。`let onUpdate` の宣言の型も合わせる
  - 廃止したゲート（`card-commands.test.ts` の `explore` / `verify`）: テストが確かめたいことは「本文の `## レビュー` にエントリを足す」「理由の `##` の節は書ける」で、ゲートの種類ではない。今あるゲート `plan` に置き換え、期待する本文の見出しも合わせる
  - わざと型に合わない値を渡して拒むことを確かめるテストがあれば、そこだけ `as unknown as <型>` で渡す（`@ts-expect-error` では型が合ってしまったときに気付けないため、使わない）
- 直した後も、テストの件数と結果は変えない（`npm test` の件数が直す前と同じであることを確かめる）

### 仮定

- **3 本目に足す。** `tsconfig.test.json` は `tsconfig.json` の対象をすべて含むので、1 本目を置き換えても同じ検査になるが、人の答え（探索メモ 4）どおり足す形にする。1 本目はビルドの設定そのものの確かめとして残す
- **`src/web/` のテストは扱わない。** `src/web/` は vitest の対象外で、テストも無い（CLAUDE.md）
- **lint の設定は変えない。** 型検査は ESLint の `parserOptions.project`（`tsconfig.eslint.json`）とは別で、ESLint はもうテストを含めて型付きで読んでいる
- **Windows の CI の行もテストの型検査を走らせる。** その行はテストを走らせないが、型検査は OS に依らないので、走らせて困らない
- **手順書の版は上げない。** `.claude/` の手順書は変えない

### 退けた代案

- **vitest の `typecheck` を使う:** 設定が増え、`tsc` と細かい違いが出うる（人と決めた、2026-11-05）
- **直せないものを `@ts-expect-error` で黙らせて先にゲートに入れる:** 元のずれが残る（人と決めた、2026-11-05）
- **テスト用の値を作る関数を共通にまとめる:** 差分が大きくなる。型検査が入れば写し忘れには気付ける（人と決めた、2026-11-05）
- **1 本目の `tsc --noEmit` を `tsconfig.test.json` で置き換える:** 同じ検査を 1 回減らせるが、人の答えは「3 本目に足す」だった。速さが問題になれば別のカードで見直す

### Risks / Trade-offs

- `npm run typecheck` が、テストの分だけ遅くなる（数秒の見込み）
- 本体に項目を足すたびに、テスト用の値も直す手間が増える。それがこのカードの狙いである

### Non-Goals

- テスト用の値を作る関数の共通化
- ESLint のテストの緩め（`no-explicit-any`、関数の行数の上限）を外すこと
- テストの中身や件数を変えること

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                               | 反映した先                      | 反映しなかった理由 |
| --- | ------------------------------------------------------------------ | ------------------------------- | ------------------ |
| 1   | 今は 40 件落ちる（内訳）                                           | Why、Decisions の直し方、Impact |                    |
| 2   | `src/shared/` のテストは、もう型検査に入っている                   | Why                             |                    |
| 3   | 40 件を全部直してゲートに入れる。`@ts-expect-error` で先送りしない | Decisions、退けた代案           |                    |
| 4   | 走らせ方は `tsc` を 3 本目に足す                                   | Decisions、仮定、退けた代案     |                    |
| 5   | テスト用の値を作る関数は共通にまとめない                           | Non-Goals、退けた代案           |                    |
| 6   | ESLint のテストの緩めはそのまま                                    | 仮定、Non-Goals                 |                    |

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/typecheck-tests`（以下 `$WT`）。共有のカードには触らないので、`AI_BOARD_DATA` は要らない。

1. テストの型のずれで型検査が落ちる
   - コマンド: `$WT` の外にワークツリーを 1 つ作り、テストの値から 1 項目を消して（例: `forge-poller.test.ts` の `makeMr` の `latestAiNoteAt`）`npm run typecheck`
   - 期待: `tsconfig.test.json` の `tsc` が、その行を指して 0 以外で終わる
2. 直した後は型検査が通る
   - コマンド: `cd "$WT" && npm run typecheck`
   - 期待: 0 で終わる
3. テストの件数と結果が変わらない
   - コマンド: 直す前の `origin/main` と `$WT` で `npm test`
   - 期待: どちらも同じ件数がすべて通る
4. CI で走る
   - コマンド: `ai-board pr checks <mr>`
   - 期待: `check (24)` / `check (26)` / `windows` が通る

## タスク

### 1. テストの型エラーを直す

- [x] `forge-poller.test.ts` の `vi.fn()` に型引数を付け、`makeCard` などテスト用の値を今の型に合わせる
- [x] `board.e2e.test.ts`・`composition.test.ts`・`status-html.test.ts`・`stage-resolver.test.ts`・`cli-runner.test.ts` のテスト用の値に、足りない項目を足し、形を今の型に合わせる
- [x] `card-commands.test.ts` の廃止したゲート（`explore` / `verify`）を `plan` に置き換え、期待する本文を合わせる
- [x] テストまで含めた `tsc`（`tsconfig.test.json` の形の設定）で 0 件になり、`npm test` の件数が直す前と同じであることを確かめる
- [x] 品質ゲートを通す

### 2. 型検査に入れる

- [x] `tsconfig.test.json` を足し、`package.json` の `typecheck` から 3 本目として呼ぶ
- [x] `README.md` の品質ゲートの節に、テストも型検査に入ることを書く
- [x] 品質ゲートを通す

## AI レビュー

- [x] `README.md:805` の CI の段落は、Windows の行が「テストを除いた typecheck」を走らせると書いたままだが、この PR で `npm run typecheck` が `tsconfig.test.json` も走らせるようになり、Windows の行もテストを型検査する（計画の仮定「Windows の CI の行もテストの型検査を走らせる」、`.github/workflows/ci.yml:58`）。すぐ下に足した段落とも食い違う。「テストを除いた typecheck」を「typecheck（テストも含む）」のように、Windows の行で走らないのはテストの実行だけだと分かる書き方に直す

### 見送った指摘

- `package.json:26` の 1 本目の `tsc --noEmit` は、3 本目の `tsconfig.test.json` が同じ対象をすべて含むので重複する。人の決めた「3 本目に足す」（計画の仮定・退けた代案）どおりなので見送る。速さが問題になれば別のカードで見直す
- `tsconfig.json` がテストを除外したままなので、エディタではテストのファイルが別の設定で開かれ、ずれは `npm run typecheck` まで見えない。`tsconfig.json` にテストを含め、出力用の `tsconfig.build.json` で除く分け方にすれば直るが、設定の組み替えはこの PR の目的（ゲートでずれに気付く）の外なので見送る
- `src/shared/**/__tests__` が `tsconfig.web.json` と `tsconfig.test.json` の両方で、別の `types` のもとに検査される。この PR の前から web の設定には入っており、今は両方で通っているので見送る
- `vitest.config.ts` などの根の設定ファイルは、どの `tsc` の対象にも入っていない。この PR の目的（テストの型検査）の外なので見送る
