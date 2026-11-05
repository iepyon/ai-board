---
id: typecheck-tests
title: AIエージェントは、テスト用の値が本体の型とずれたら、品質ゲートで気付きたい
created: '2026-10-23T06:19:17.968Z'
skipGates: []
branch: typecheck-tests
mr: 84
---

## アイデア

テスト（`src/**/__tests__/**`）も型検査の対象にし、品質ゲートと CI で落ちるようにする。

- テスト用の tsconfig（例: `tsconfig.test.json`。`tsconfig.json` を継承し、`__tests__` を除外しない）を足し、`npm run typecheck` から呼ぶ
- 今出る 7 件の型エラーを直す（下の背景）
- `src/web/` はテストの対象外なので、今までどおり含めない

## 背景

`tsconfig.json` は `**/__tests__/**` を除外しており、vitest は型を見ずに実行する。そのため、テストは型検査を一度も通っていない。
2026-10-23 にテストを含めて `tsc` をかけたところ、型エラーが 7 件出た。どれも、本体の作りが変わったときにテスト用の値が追従していないものである。

- `forge-poller.test.ts`: `makeCard` が、今の `Card` に無い `explored` / `implStartedAt` / `change` / `stageOverride` を持ち、`startedAt` などを欠いている
- `card-commands.test.ts`: 廃止した `explore` ゲートを使っている
- `board.e2e.test.ts`: `MrState` に足した `draft` が無い
- `stage-resolver.test.ts`（2 件）・`cli-runner.test.ts`: テスト用の値が今の型と合わない
- `forge-poller.test.ts:242`: クロージャで代入した変数を TS が `never` と推論する（実害は無いが、型の書き方を直す）

テストは通っているので今は害が出ていないが、テスト用の値が本体とずれていくと、テストが本当の形のデータを検査しなくなる。
CLAUDE.md の品質ゲートは「typecheck → lint → test」で、テストの型は誰も見ていないことに気付きにくい。

## 論点

- **置き場所。** `npm run typecheck` に 3 本目の `tsc -p tsconfig.test.json` を足すか、vitest の `typecheck` を使うか。
  CLAUDE.md は「`typecheck` は tsc を 2 回走らせる」と書いているので、どちらにしても書き換える
- **テストで緩めている lint との関係。** ESLint はテストの `no-explicit-any` を緩めている。型検査を入れても `any` は通るので、そのままでよいか
- **CI。** `.github/workflows/ci.yml` は `npm run typecheck` を呼んでいるので、`typecheck` に入れれば CI にも乗る

## 探索メモ

2026-11-05 に、今の main（`6efffb6`）でテストまで含めて `tsc` をかけ、人に聞いた。

1. **今は 40 件落ちる**（カードの 7 件は 2026-10-23 の数）。内訳は次のとおり
   - `forge-poller.test.ts` 27 件。ほとんどが `vi.fn()` を `onUpdate`（`() => void`）に渡すところの型（`Mock<Procedure | Constructable>`）
   - `board.e2e.test.ts` 5 件・`composition.test.ts` 1 件・`status-html.test.ts` 1 件・`stage-resolver.test.ts` 3 件: 本体に足した項目（`latestAiNoteAt` など）がテストの値に無い・形が今の型と合わない
   - `card-commands.test.ts` 2 件: 廃止したゲート（`explore` / `verify`）を渡している
   - `cli-runner.test.ts` 1 件: `CliError` の `httpStatus` が無い
2. **`src/shared/` のテストは、もう型検査に入っている。** `tsconfig.web.json` の `include` が `src/shared/**/*.ts` を丸ごと含むため（`forge-card-error` で `kind` を足したときに落ちて気付いた）
3. **40 件を全部直してゲートに入れる**（人に聞いた、2026-11-05）。`@ts-expect-error` で黙らせて先送りはしない
4. **走らせ方は `tsc` を 3 本目に足す**（人に聞いた、2026-11-05）。`tsconfig.test.json` を足して `npm run typecheck` から呼ぶ。vitest の `typecheck` は使わない
5. **テスト用の値を作る関数（`makeMr` / `makeCard` など、9 ファイル）は共通にまとめない**（人に聞いた、2026-11-05）。このカードは型を合わせるだけにし、差分を小さく保つ
6. **ESLint のテストの緩め（`no-explicit-any` と関数の行数の上限）はそのまま**（人に聞いた、2026-11-05）
