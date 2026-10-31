# レビューの指示

プロジェクト全体の規約は `CLAUDE.md` にある。ここにはレビューだけに効く指示を置く。
指摘は日本語で書く。

## このリポジトリで Important とするもの

挙動を壊す・境界を崩す・戻せなくするものに限る。

- **コマンド注入の経路。** 外部コマンドの実行は `src/infrastructure/cli-runner.ts` の `execFile` に閉じる。
  shell を介した実行、文字列連結で組み立てたコマンド、カードの `branch` などの値を
  引数配列以外の形でコマンドへ渡すものはすべて Important。
- **書き込み境界の崩れ。** `src/cards/cli/card-cli.ts` に `startedAt` / `rank` / `skipGates` を書く入口や、
  承認 / 否決 / 中止を追記する入口を足すもの。`body` の差し替えで `## レビュー` の既存エントリを
  変えられるようにするもの。サーバが `.ai-board/plans/` に書き込むもの。
- **ステージ導出の迂回。** ステージを保存する・直接指定する入力口を作るもの。
  `src/board/services/stage-resolver.ts` の `RULES` 配列の外でステージを決める分岐を足すもの。
  否決の差し戻しや区切り線（`DIVIDER_ID`）のための専用の `if` もここに含める。
- **計画ファイルの存在で列が立つ保険を外すもの。** 「空ファイルは無視する」などの条件。
  また `plan.repository.ts` で不正なファイル名に例外を投げ、ボード全体を 500 にするもの。
- **DB マイグレーションの後方互換。** `src/infrastructure/database.ts` の `MIGRATIONS` は追記のみ。
  既存の要素を書き換える・並べ替えるものは Important。DB はワークツリー間で共有される。
- **GitHub の PR の状態の取り違え。** `closed` を `merged_at` を見ずに扱うもの、
  コメントや commits の 1 ページ目だけを見て最新を決めるもの（`--paginate` で全ページ引く）。
- **アクセストークンを読む経路。** 設定ファイル・環境変数からトークンを読むもの。認証は `gh` に委ねる。
- **エラー種の網羅漏れ。** usecase のエラー union に種類を足したのに
  `*-error-mappings.ts` の `switch` が網羅していないもの、usecase が `Result` を返さず例外を投げるもの。
- **サーバの bind 先を `127.0.0.1` 以外へ広げるもの。** 認証を持たないローカル専用ツールである。

## 必ず確かめること

- 画面のロジックを `src/web/` に直接書いていないか。`src/web/` はテストの対象外なので、
  判断を含むロジックは `src/shared/dashboard-sections.ts` などの純関数へ切り出してテストする。
- 足したテストが `src/**/__tests__/**/*.test.ts` の glob の中にあるか。外にあると vitest が黙って無視する。
- `src/shared/` に Node 専用 API を持ち込んでいないか（web の tsconfig でも通る必要がある）。
- 依存を usecase やリポジトリの中で `new` せず、`composition.ts` で組んでいるか。
- ID を生の string で渡さず、`createCardId` などのファクトリを通しているか。
- `PATCH` の入力で `undefined`（変更しない）と `null`（消す）を区別しているか。
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
