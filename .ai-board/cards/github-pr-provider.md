---
id: github-pr-provider
title: GitHub の PR をボードに乗せる
created: '2026-09-21T02:10:00.000Z'
startedAt: '2026-09-21T02:34:51.243Z'
skipGates: []
change: github-pr-provider
branch: github-pr-provider
mr: null
---

## アイデア

ai-board 自身を GitHub（`iepyon/ai-board`）で公開し、開発の主線も当面そちらへ移した。
一方で MR 状態の取得先は `.ai-board/config.yaml` が指すローカル GitLab のままなので、
**GitHub の PR で回すとカードの `mr` が解決されず、`PR中` / `マージ済み` の列が
MR 由来の情報を失う。** ボードは落ちず openspec 由来の情報だけで動くが、
7 段のうち後ろ 2 段が実質機能しない。

やりたいのは GitLab を GitHub へ「置き換える」ことではなく、
**取得先をもう 1 つ選べるようにする**こと。ローカル GitLab は検証環境として残す。

## 前提

接ぎ木する場所はもう切ってある。

- `MrStateProvider`（`src/board/services/mr-state-provider.ts`）が
  「ボード描画時にネットワーク I/O をしない」ための抽象。実体はポーラーのキャッシュ。
- 未設定時は `disabledMrStateProvider` に落ち、`connection()` が `disabled` を返す。
- `loadConfig` は `gitlab` セクションと環境変数 `AI_BOARD_GITLAB_TOKEN` の
  両方が揃ったときだけ連携を有効にする（`src/shared/config.ts`）。

つまり足すのは provider の実装と設定の分岐であって、ステージ導出には触らない。
`stage-resolver.ts` は `MrState` しか見ていないので、ここに `if` が増えるなら設計を疑う。

## 決めたこと

人の判断で 3 点を確定した（2026-09-21）。

**① 取得先は排他選択にする。**
`config.yaml` に `gitlab:` と `github:` のどちらか一方だけを書く。
両方書かれていたらエラーにする。先勝ちのような曖昧な解決はしない。
トークンの環境変数も取得先ごとに分ける。

**② カードの語彙は `mr` のまま据え置く。**
`MergeRequestIid` も frontmatter の `mr` も変えない。
GitHub では PR number を `mr` に書くことになり呼び名はずれるが、
値の性質（正の整数）は同じで、既存カード 21 枚と `card.schema.ts` の
移行コストに見合わない。中立化はあとから判断できる。

**③ コメント数は 2 種類を合算する。**
`latestNoteAt` / `noteCount` は GitLab では「system でない最新ノート」1 か所から取れるが、
GitHub では PR 全体への issue comment とコード行への review comment が
別エンドポイントに分かれている。両方に問い合わせて合算する。
API 呼び出しは倍になるが、GitLab と GitHub で数字の意味がずれる方が後で混乱する。

## 未決

- `MR_STATES` の `locked` に GitHub の対応物が無い。落とすのか、GitHub 側では
  現れない値として残すのかは提案書で詰める。
- ポーラーを 1 つに保つか、取得先ごとに分けるか。

## 探索メモ

- GitLab 側は「MR 一覧の全件取得はページングで取りこぼす」ためカード単位で問い合わせている。
  GitHub も同じ方針で、`branch` から PR を引く形になるはず。
- `gitlab-poller.ts` はポーリング間隔とキャッシュを持つ。provider が増えても
  ポーラーは 1 つでよいか、実装ごとに分けるかは設計時に決める。
- 公開したことで、他人が clone した環境では両方とも未設定になる。
  `disabled` の見え方が初見の人の最初の体験になるので、そこの文言も見ておきたい。

## レビュー

### 2026-09-21T03:24:55.924Z plan 提出

proposal / specs / design / tasks を作成。`openspec validate --strict` 通過。
判断待ちの点は 2 つ。取得先の問い合わせを `gh` / `glab` の実行に委ねトークンを
廃止すること（CLI のログインが実行時の前提になる）と、`GET /api/board` の
接続状態フィールドを `gitlab` から `forge` へ改名すること。

### 2026-09-21T03:28:41.567Z plan 承認

判断待ちだった 2 点を含めて承認。取得先の問い合わせを gh / glab の実行に委ね
トークンを廃止する方針、および接続状態フィールドの forge への改名を了承する。
（セッション内で人が承認を指示し、その指示に基づきエージェントが追記した）
