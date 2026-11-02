# 0001. usecase は例外を投げず Result を返し、依存はコンテキストごとの composition.ts で組む

- 状態: 採用
- 日付: 2026-09-04
- 置き換え元: なし
- 置き換え先: なし

## 状況

最初のコミット `0e3dd81` で、ボードはカードの CRUD（`cards/`）とステージ導出（`board/`）の
2 つのコンテキストを持つ Express アプリとして書かれた。各コンテキストは
`models/ errors/ repositories/ usecases/ controllers/ composition.ts` の層を持ち、
`src/shared/result.ts` に `Result<T, E>` を置いていた。

この時点ではこれらは規約として書かれておらず、コードの形として存在するだけだった。
翌日の `agents-md` カードは「AI がこのリポジトリの規約を知る手段が無い。ループを回すなら必須」として、
`Result<T,E>` / discriminated union / Composition Root の規約を CLAUDE.md に書くことを挙げた。

なぜこの形を選んだかは、最初のコミットにも CLAUDE.md にも書かれていない。

## 決定

- **usecase は例外を投げず `Result<T, E>` を返す。**
- **エラーは discriminated union（`{ type: 'CardNotFound', id }`）で表す。**
  controller が `*-error-mappings.ts` の `switch` で HTTP ステータスへ変換し、
  エラー種を増やしたら `switch` も網羅する。
- **依存はコンテキストごとの `composition.ts`（Composition Root）で組む。**
  usecase やリポジトリの中で `new` して依存を作らない。

## 検討した代案

記録なし。

## 結果

- エラー種を足すとマッピングの `switch` の網羅漏れを型が検出する（CLAUDE.md は「型が漏れを検出する」と書いた）。
- 規約が CLAUDE.md に入り、AI エージェントが読んで従える形になった。
  外部コマンドの実行もこの形に揃え、失敗を `CliError` の union として `Result` で返す
  （[0006](0006-cli-runner-no-shell.md)）。
- 実装の差し替え点が composition root に集まる。GitHub の PR を足したときは、
  取得先の実装を composition root が設定の `kind` で選ぶ形にした（[0005](0005-delegate-auth-to-cli.md)）。
- 規約の理由が書かれないまま残った。外してよいかを判断する材料は、この ADR にも無い。

## 根拠

- コミット: `0e3dd81` feat: OpenSpec 駆動開発のためのローカル Web カンバンを追加
- コミット: `c6ccf5d` docs: CLAUDE.md でリポジトリの規約を明文化する（MR !2、カード `agents-md`）
- `CLAUDE.md`「コードの規約」
- `src/shared/result.ts`、`src/cards/composition.ts`、`src/cards/controllers/card-error-mappings.ts`
