---
id: typecheck-tests
title: AIエージェントは、テスト用の値が本体の型とずれたら、品質ゲートで気付きたい
created: '2026-10-23T06:19:17.968Z'
skipGates: []
branch: null
mr: null
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
