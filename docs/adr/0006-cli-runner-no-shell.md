# 0006. 外部コマンドは cli-runner に閉じ、shell を介さず引数を配列で渡す

- 状態: 採用
- 日付: 2026-09-21
- 置き換え元: なし
- 置き換え先: なし

## 状況

github-pr-provider で、取得先への問い合わせを `fetch` から `gh api` / `glab api` の実行へ変えることにした
（[0005](0005-delegate-auth-to-cli.md)）。

問い合わせにはカードの `branch` を使う。カードファイルは人とエージェントが自由に編集でき、
`branch` には任意の文字列が入り得た。ai-board は `127.0.0.1` にのみ bind するローカル専用ツールだが、
それは外からの到達を防ぐだけで、入力の素性を保証しない。
また、応答しない CLI が 30 秒ごとのポーリングを止めてしまうおそれがあった。

## 決定

- **外部コマンドの実行は `src/infrastructure/cli-runner.ts` に閉じる。**
- **`node:child_process` の `execFile` を使い、shell を介さない。** `shell: false` を既定に頼らず明示する。
  ブランチ名・識別番号・リポジトリ指定はすべて引数配列の要素として渡し、文字列連結でコマンドを組まない。
- タイムアウトと出力サイズの上限を付ける。
- 例外を投げず、失敗を `NotInstalled`（前提が満たされていない）・`Failed`（実行できたが結果が得られない）・
  `InvalidJson` の判別可能な union として `Result` で返す（[0001](0001-result-and-composition.md)）。
  呼び出し側が利用者に出す文言を出し分けられるようにするため。
- `Failed` には stderr の本文を載せず、HTTP ステータスの数字 3 桁だけを取り出す。資格情報が混ざる余地を断つ。

## 検討した代案

記録なし（shell を介す案や、文字列連結でコマンドを組む案が比べられた記録は無い。計画は危険の説明として挙げている）。

## 結果

- カードを書ける者がブランチ名を通じて任意のコマンドを実行する経路が無くなった。
  ブランチ名にシェルの特殊文字を含めてもコマンドとして解釈されないことをテストで固定した。
- 応答しない CLI や想定外に大きな応答で、ポーリングが止まったりメモリを食ったりしない。
- **外部コマンドは cli-runner に閉じ、shell を介さず引数は配列で渡す**は CLAUDE.md の不変条件になった。
  カードの `branch` は誰でも書けるので、文字列連結でコマンドを組むと任意のコマンドを実行できてしまう、という理由と一緒に書かれている。
- 後に、ブランチ上の計画の読み取りとデータ用ブランチの git 操作も cli-runner を通るようになった
  （`branch-plan.repository.ts`・`data-store.ts`）。git の stderr も同じ理由で終了コードまでにとどめる。
- ブラウザを開く処理（`cli-main.ts`）だけは cli-runner を通らず `spawn` を直接使う。引数は配列で渡している。

## 根拠

- 計画: `.ai-board/plans/archive/github-pr-provider.md`（Decisions「CLI の実行は shell を介さず、引数を配列で渡す」・タスク 2）
- コミット: `cf402fc` feat: GitHub の PR をボードに乗せ、認証を gh / glab に委ねる
- `src/infrastructure/cli-runner.ts` の docstring、`src/infrastructure/data-store.ts`、`src/cli-main.ts`
- `CLAUDE.md`「設計の不変条件」
