---
id: agents-md
title: AGENTS.md / CLAUDE.md でリポジトリの規約を明文化する
created: '2026-09-04T06:48:23.409Z'
explored: false
implStartedAt: null
change: null
branch: add-claude-md
mr: 2
stageOverride: null
---

## アイデア

AI がこのリポジトリの規約を知る手段が無い。ループを回すなら必須。

書くこと。

- コマンド一覧、レイヤー構成、`Result<T,E>` / discriminated union / Composition Root の規約
- **書き込み境界**: `openspec/` は AI が書く / `.ai-board/` はボードが書く
- ステージ制限の意味（人の列と AI の列、AI がやってはいけないこと）
- ESM で import に `.js` を書く、パスエイリアスを使わない理由
- openspec v1.3.1 の実装に合わせた判定ロジック（archive の日付プレフィックスなど）
- 日本語 Conventional Commits

## 実装メモ

CLAUDE.md を作成し MR !2 で出した。書いたのは列挙のとおり。
書き込み境界は「主体ごと」に分けた — ボードのサーバは `openspec/` を read-only、
AI エージェントは `/opsx:*` で `openspec/` を書く。一枚にまとめると spec 駆動が回らない。

規約と実装を突き合わせる過程で見つかった食い違いも同じ MR で直した。
tasks の行パターン（インデントされたサブタスクが進捗から消えていた）、
README の存在しない `examples/demo`、疎通確認 curl のポート、
追従先を v1.3.1 → v1.12.0 に改めて腐った行番号参照を定数名へ。

残り。

- **AGENTS.md は作っていない。** CLAUDE.md のみ。両方要るなら別カードか本カードの続き
- openspec #1309（change 名自体が日付で始まると接頭辞を重ねず archive する）は未追従。
  README と CLAUDE.md に既知として書いただけ
