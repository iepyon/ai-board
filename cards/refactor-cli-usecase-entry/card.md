---
id: refactor-cli-usecase-entry
title: 'リファクタリング: AIエージェントは、CLI の層に残るロジックを usecase へ移し、HTTP の入口を足しても同じ処理を二重に書かずに済ませたい'
created: '2026-11-11T06:49:14.186Z'
skipGates: []
branch: null
pr: null
---

## アイデア

CLI の層に残っているロジックを、入口に依存しない場所（usecase・組み立ての関数・services の純関数）へ移す。
後で HTTP の入口を足したときに、同じ処理を二重に書かずに済むようにする。動きは変えない。

## 背景

画面とサーバは ADR 0017 でいったん外したが、後で戻し、CLI と HTTP の両方から同じ usecase につなぐ予定である。
`status` と `decide` は、CLI（`status-cli.ts` / `decide-cli.ts`）が usecase を呼ぶだけの形になっている。一方で、次の箇所は CLI の層にロジックがある（2026-11-07 に確かめた）。

- `src/cli-main.ts` の `runStatus` と `runDecide` が、「データ用ブランチの取り直し → オフラインなら警告 → `assembleBoard`」という同じ手順を書いている
- `src/cards/cli/card-cli.ts` の `runSeed` が、既にある ID を飛ばす判定と、競合したときに飛ばしたとみなす判定を持っている（usecase にすべき中身）
- `card-cli.ts` の `runHold` と `runCreate` で、理由・タイトルは必須で前後の空白は落とす、という検査を CLI がしている。`hold-review.command.ts` は理由をそのまま渡し、検査していない
- `src/board/cli/pr-cli.ts` の CI の待ち方の判定（`nextCheckStep` / `isSettled`）が CLI の中にある

## 論点

- ボードの組み立て（取り直し・オフラインの扱い・`assembleBoard`）を、どこに 1 つの関数として置くか（`src/board/composition.ts` に寄せる、など）。サーバでいつ取り直すか（リクエストごとか、ポーリングか）は、このカードでは決めない
- seed を usecase（例: `seedCardsCommand`）にするとき、AI に許す書き込みの境界（`CardCliDependencies.writes`）を崩さない
- `hold` の理由と `create` のタイトルの検査を usecase へ移すか、両方に置くか
- CI の待ち方の判定を `services` の純関数に出すか（HTTP で要るかは分からないので、優先度は低い）

## 探索メモ

- 人と決めた（2026-11-07）: 画面とサーバは後で戻し、CLI と HTTP の両方から usecase につなぐ
- HTTP は人の入口になる見込みである。入口ごとに許す操作の組（AI 用 / 人用）を `composition.ts` で別々に組んで渡す形は、サーバを戻すときに決める（ADR 0007）
- 2026-11-07 に今のコードで確かめ直し、`runCreate` のタイトルの検査と `hold-review.command.ts` が検査していないことを書き足した
