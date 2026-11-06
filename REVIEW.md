# レビューの指示

プロジェクト全体の規約は `CLAUDE.md` にある。ここにはレビューだけに効く指示を置く。
指摘は日本語で書く。

## このリポジトリで Important とするもの

挙動を壊す・境界を崩す・戻せなくするものに限る。

- **コマンド注入の経路。** 外部コマンドの実行は `src/infrastructure/cli-runner.ts` の `execFile` に閉じる。
  shell を介した実行、文字列連結で組み立てたコマンド、カードの `branch` などの値を
  引数配列以外の形でコマンドへ渡すものはすべて Important。
- **書き込み境界の崩れ。** `src/cards/cli/card-cli.ts` に `startedAt` / `rank` / `skipGates` を書く入口や、
  承認 / 差し戻し / 中止を追記する入口を足すもの。`body` の差し替えで `## レビュー` の既存エントリを
  変えられるようにするもの。`ai-board` の CLI が `.ai-board/plans/` に書き込むもの。
- **ステージ導出の迂回。** ステージを保存する・直接指定する入力口を作るもの。
  `src/board/services/stage-resolver.ts` の `RULES` 配列の外でステージを決める分岐を足すもの。
  差し戻しや区切り線（`DIVIDER_ID`）のための専用の `if` もここに含める。
- **計画ファイルの存在で列が立つ保険を外すもの。** 「空ファイルは無視する」などの条件。
  また `plan.repository.ts` で不正なファイル名に例外を投げ、ボード全体を読めなくするもの。
- **DB マイグレーションの後方互換。** `src/infrastructure/database.ts` の `MIGRATIONS` は追記のみ。
  既存の要素を書き換える・並べ替えるものは Important。DB はワークツリー間で共有される。
- **GitHub の PR の状態の取り違え。** `closed` を `merged_at` を見ずに扱うもの、
  コメントや commits の 1 ページ目だけを見て最新を決めるもの（`--paginate` で全ページ引く）。
- **アクセストークンを読む経路。** 設定ファイル・環境変数からトークンを読むもの。認証は `gh` に委ねる。
- **エラー種の網羅漏れ。** usecase のエラー union に種類を足したのに
  CLI のエラーの文言の `switch` が網羅していないもの、usecase が `Result` を返さず例外を投げるもの。
- **待ち受けるサーバを足すもの。** 画面とサーバはいったん外した（ADR 0017）。作り直すときは、認証を持たないので `127.0.0.1` にだけ bind する。

## 必ず確かめること

- 区画や判断を含むロジックを CLI の出力の組み立ての中に埋めず、`src/shared/dashboard-sections.ts` などの純関数へ切り出してテストしているか。
- 足したテストが `src/**/__tests__/**/*.test.ts` の glob の中にあるか。外にあると vitest が黙って無視する。
- 依存を usecase やリポジトリの中で `new` せず、`composition.ts` で組んでいるか。
- ID を生の string で渡さず、`createCardId` などのファクトリを通しているか。
- 部分更新の入力で `undefined`（変更しない）と `null`（消す）を区別しているか。
- 挙動を変える変更で、`CLAUDE.md` / `README.md` / `docs/architecture.md` の該当箇所が古くなっていないか。

## 報告しないこと

- CI が既に検査しているもの: 型エラー、ESLint、Prettier の整形、カバレッジ閾値。
- `package-lock.json` の差分。
- `.ai-board/plans/archive/` への移動だけの差分。
- 計画ファイル（`.ai-board/plans/*.md`）の文章の言い回し。計画の中身は人が Draft の PR で判断する。

## 指摘の出し方

- Nit は 1 レビューにつき 5 件まで。
- 挙動についての主張には、根拠となるソースの `file:line` を付ける。名前からの推測で書かない。
- 設計の好み（命名・分割の仕方）は Nit を上限とする。上の Important に当たるものだけをマージを止める理由にする。
