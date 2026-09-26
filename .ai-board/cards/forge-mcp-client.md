---
id: forge-mcp-client
title: レビュー要求を MCP サーバ経由でも引けるようにする
created: '2026-09-21T04:49:00.868Z'
startedAt: null
skipGates: []
branch: null
mr: null
forge: null
---

## アイデア

レビュー要求の取得は `gh api` / `glab api` の**実行**に固定されている。
CLI が入っていて、かつログイン済みであることが実行時の前提で、
満たさなければ `checkAuth` が弾いて `disabled` になり、`PR中` / `マージ済み` の
2 列が空のままになる。ボードは落ちないが、7 段のうち後ろ 2 段が機能しない。

この前提が成り立たない環境が実際にある。Claude Code のクラウド実行環境には
`gh` も `glab` も入っておらず、`GH_TOKEN` の中身は `proxy-injected` という
プレースホルダで、本物の資格情報はコンテナの外のプロキシと MCP サーバが持つ。
GitHub API を触る手段は `gh` ではなく MCP サーバ（`mcp__github__*`）になっている。
そういう場所では今の ai-board は後ろ 2 段を諦めるしかない。

やりたいのは CLI を置き換えることではなく、**取得の手段をもう 1 つ選べるようにする**こと。
手元で `gh` にログインしている人の体験は変えない。

## 前提

接ぎ木する場所は `github-pr-provider` で切ってある。

- `ForgeClient`（`src/board/services/forge-client.ts`）は
  `fetchByIid` / `fetchByBranch` / `checkAuth` の 3 つしか要求しない。
  MCP 経由の実装を 4 つ目のメソッドを足さずに並べられるはず。
- 取得先ごとの分岐は `createForgeClient`（`src/board/composition.ts`）1 か所に閉じている。
- ポーラー（`ForgePoller`）は `ForgeClient` しか見ないので触らずに済む。
- ステージ導出は `MrState` しか見ない。`stage-resolver.ts` に `if` が増えるなら設計を疑う。

一方で、CLI 実行を閉じ込めた `src/infrastructure/cli-runner.ts` は使えない。
MCP は CLI ではないので、同じ層に別の口が要る。

## 未決

**① 認証をどこへ委ねるか。** 「アクセストークンは扱わない」が既存の原則で、
設定ファイルからも環境変数からもトークンを読む経路を持たないことで守っている。
MCP サーバへの接続で同じ線を引けるかがこのカードの核心。stdio 起動なら
CLI と同じく「起動した先のログイン状態に委ねる」で通るが、HTTP 接続だと
何らかの資格情報を持つことになりかねない。ここが通らないなら、この案は捨てる。

**② 設定の形。** 今は `gitlab:` / `github:` の排他選択で、`ForgeConfig` の
`kind` がそのまま実装の選択になっている。ここに「取得先（GitLab / GitHub）」と
「取得方法（CLI / MCP）」という直交する 2 軸が現れる。`kind` を 3 値へ増やすのか、
`github:` の下に `via: cli | mcp` を置くのか。前者は組み合わせが増えたときに破綻する。

**③ MCP サーバをどう起動・接続するか。** stdio のサブプロセスか、既に動いている
サーバへの接続か。前者ならサーバ起動のたびに別プロセスが増える。
ローカル専用ツールとしての軽さとの兼ね合い。

## 探索メモ

- `checkAuth` の「起動時に 1 度だけ確かめる」設計は MCP でもそのまま使えそう。
  接続できなければ理由付きで `disabled` に落ちる導線も共通。
- MCP のツール呼び出しは `gh api` のような生のエンドポイント指定ではなく、
  `pull_request_read` のような粒度の粗い操作になる。`enrich` が
  issue comment / review comment / head commit を個別に引いている今の形と
  合うかは要確認。合わないなら `MrState` を埋めきれない項目が出る。
- そもそも ai-board を動かす人が MCP サーバを持っている状況がどれだけあるか。
  クラウド実行環境でボードを開く導線（127.0.0.1 bind のまま）とセットで考えないと、
  「取得はできるが画面が開けない」になる。ここが弱いなら優先度は低い。

## レビュー

### 2026-09-21T10:59:21.092Z plan 中止

MCP 経由の取得は成立しない。mcp__github__* はエージェントのツール面でサーバはコンテナ外にあり、ai-board のプロセスからは接続先として届かない。egress プロキシも資格情報を注入しないため素の api.github.com は匿名扱いになる。トークンを許容するなら MCP を挟む理由が消え、HTTP 直叩きのほうが短い。本当の障壁は取得ではなく画面（127.0.0.1 bind・認証なし）なので、そちらを先に決める。
