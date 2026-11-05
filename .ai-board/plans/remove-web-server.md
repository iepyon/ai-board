# 画面とサーバをいったん外し、ボードを CLI とチャットとダッシュボードだけで扱う

## 人に判断してほしいこと

- **手順書の版を上げるか。** `rules.md`・`board-decide`・`board-dashboard` などから画面とサーバの記述を消すので、`.claude/HARNESS_VERSIONS.md` に v2 を足す（既定: 上げる）
  - → 回答（2026-11-05、plan 承認）: 理由なしで承認（既定のまま進む）
- **`ai-board status` の出力から「サーバ:」の行と JSON の `server` を消してよいか。** `--only server` を渡している呼び出し元は使い方の誤りで拒まれるようになる（既定: 消す。手順書と ai-board 自身は `server` を読んでいない）
  - → 回答（2026-11-05、plan 承認）: 理由なしで承認（既定のまま進む）

## 提案

### Why

ボードの画面（`src/web/` の React）と、画面のためにあるサーバ（HTTP API・SSE・ファイル監視・データ用ブランチの取り直し・GitHub のポーラー）が、考えることの多くを占めている。
2026-11-05 に GitHub API の上限対策（`forge-poll-budget`）でサーバのポーリングの減らし方を話すうちに、画面を外せばポーリング・控えの食い違い・`src/shared/` を両方でビルドする制約を考えずに済むと分かった。
判断は既にチャットから `ai-board decide` で書け（ADR 0007）、ボードは `status --html` のダッシュボードで見られる（ADR 0015）。
人と相談して、画面とサーバをいったん消し、後でゼロから作り直すことにした。

### What Changes

- `src/web/` と Vite の設定、`src/server.ts` / `src/app.ts` / `src/index.ts`、controller と HTTP のエラーのマッピング、`src/shared/controllers` / `src/shared/middleware` を消す
- サーバだけが使う基盤（`sse.ts` / `watch.ts` / `data-refresher.ts` / `open-browser.ts` / `server-info.ts`）と、`ForgePoller` の定期実行（`start` / `stop` と間隔の既定）を消す。GitHub を引くのは `ai-board` の CLI が 1 回の実行で 1 回だけになる
- `ai-board`（引数なし）はサーバを起動せず、使い方を出して終わる。`--port` / `--no-open` / `--poll-interval` を消す
- `ai-board status` から「サーバ:」の行と `server` の項目を消す
- 消した結果どこからも使われなくなった usecase・純関数・型を消す
- 依存（express・chokidar・react・vite・supertest など）と npm のスクリプト（`dev` / `dev:web`）を外す
- README・`docs/architecture.md`・`CLAUDE.md`・`REVIEW.md`・仕様・ADR・手順書から画面とサーバの記述を消し、画面とサーバを外した判断を ADR に残す

### Impact

- コード: `src/web/`、`src/server.ts`、`src/app.ts`、`src/index.ts`、`src/cli-main.ts`、`src/*/controllers/`、`src/shared/controllers/`、`src/shared/middleware/`、`src/infrastructure/`、`src/board/cli/status-cli.ts`、`src/board/composition.ts`
- 設定: `package.json`、`package-lock.json`、`vite.config.ts`、`tsconfig*.json`、`eslint.config.js`、`vitest.config.ts`
- ドキュメント: `README.md`、`docs/architecture.md`、`CLAUDE.md`、`REVIEW.md`、`docs/specs/*/spec.md`、`docs/adr/`
- 手順書: `.claude/skills/board-loop/`、`.claude/skills/board-decide/SKILL.md`、`.claude/skills/board-dashboard/SKILL.md`、`.claude/HARNESS_VERSIONS.md`
- 導出（`stage-resolver.ts`）・データ用ブランチの形・`ai-board card` / `decide` / `loop` / `pr` の入出力は変わらない

## 設計

### Decisions

- **画面とサーバはまとめて消す。** 画面が無ければ HTTP API・SSE・ファイル監視・取り直し・定期のポーリングを使う者がいない。片方だけ残すと、使われないコードを保守することになる
- **サーバが担っていた書き込みは、もう `status` が担っている。** `assembleBoard`（`src/cli-main.ts`）は `refresh()` を 1 回待ち、ブランチから解決した PR 番号を `createTransactionalMrWriter` で書き戻し、PR の状態の控えを保存する。移し替えは要らない
- **`ForgePoller` は残し、定期実行だけを外す。** `refresh()`・控え・カードごとの失敗の扱いは `status` / `decide` / `pr` が使う。`start` / `stop` / `intervalMs` / `DEFAULT_POLL_INTERVAL_MS` を消す
- **`ai-board`（引数なし）は使い方を出して 1 で終わる。** `--help` は 0 で終わる。使い方には `card` / `init` / `status` / `pr` / `loop` / `decide` / `dist-check` を並べる
- **`status` の `server` を消す。** 項目ごと消し、`--only` の項目の一覧からも外す。人の向けの出力の「サーバ:」の行も消す
- **使われなくなったものは、消した後に importer を辿って消す。** controller だけが使っていた usecase、`src/web/` だけが使っていた `src/shared/` の関数と型、そのテストを消す。CLI・`status --html`・テストの外で使われているものは残す
- **`src/shared/` を「サーバと web の両方でビルドする」決まりは外す。** `CLAUDE.md` のコードの規約から消す。画面を作り直すときに改めて決める
- **画面とサーバを外した判断は、新しい ADR（0017）に書く。** 画面に触れている ADR（0006 / 0007 / 0008 / 0009 / 0011 / 0015 / 0016）は、画面の記述を今の形（CLI とダッシュボード）に書き直す
- **仕様（`docs/specs/`）の「画面」は、`ai-board status` とダッシュボードの言葉に置き換える。** 中止の区画・判断待ちの区画などの区画の考え方は `status` とダッシュボードも持つので残す
- **手順書から、サーバ・`server.json`・人の API（`/api/...`）の記述を消す。** 締めの段の「画面の見た目」の例は、CLI で確かめられないものの例に置き換える

### 仮定

- `ai-board status` の `server` を読んでいる呼び出し元は無い。根拠: 手順書（`board-loop` は `--only next,waiting,forge,loop`、`board-decide` は `--only waiting,ideas,cards.*`）と `status --html` は `server` を使っていない
- CI は `ci.yml` の `check (26)` のまま変えない。根拠: `npm run build` が `tsc` だけになっても、ジョブの手順（typecheck・lint・format:check・test:coverage・build）はそのまま走る
- カバレッジの閾値（`vitest.config.ts`）は変えない。消したコードとそのテストが一緒に抜けるので、割合は大きく動かない見込み。下回ったら締めの段の前に分かる（節の終わりの `npm test` では閾値を見ないので、`npm run test:coverage` も節の終わりで走らせる）
- データ用ブランチの `server.json` の置き場所の決まり（`AI_BOARD_DATA` の親）は、書く者がいなくなるので手順書から消してよい。根拠: `server.json` を書くのは `startServer` だけ

### 退けた代案

- **画面だけを消してサーバ（API）を残す** — API を使う者がいなくなり、使われないコードと e2e を保守することになる
- **画面を表示に徹しさせ、GitHub への問い合わせを `status` に寄せる** — 画面とサーバを残す限り、ファイル監視・SSE・控えの読み直しなどを考え続けることになる。作り直す前提なら消すほうが考えることが減る
- **画面を消す前に、しばらく画面を使わずに回して困る操作を確かめる** — 人が取らないと決めた（探索メモ）
- **`ai-board`（引数なし）で `status` を出す** — 何も書かない入口が別の CLI の別名になると、使い方が 2 通りになる。使い方を出すほうが、サーバを起動していた人に変わったことが伝わる

### Risks / Trade-offs

- 常に開いておく画面が無くなり、ボードを見るのはチャットか `ai-board status` を走らせたときだけになる。判断待ちに気付くのは、ループが手の終わりにチャットで伝えるか、人が見に行ったときになる
- ドラッグでの並べ替え・本文のその場の編集が無くなる。`ai-board decide move` / `ai-board card body` か、チャットで頼む形になる
- 消す量が多い（`src/web/` だけで約 2,500 行）。節ごとに品質ゲートを通し、消し漏れは次の節で拾う

### Non-Goals

- 画面の作り直し（後でゼロから作る）
- ダッシュボード（`status --html`）の作りや見た目の変更
- `ai-board` の CLI の入出力の変更（`status` の `server` を除く）
- GitHub への問い合わせの回数のさらなる削減

## 探索メモとの対応

| #   | 探索メモ                                                                                   | 反映した先                         | 反映しなかった理由 |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------ |
| 1   | 人と決めた（2026-11-05）: 画面とサーバをいったん消す。後でゼロから作り直す                 | 提案 / Decisions / Non-Goals       |                    |
| 2   | 消す前に画面を使わずに回して困る操作を確かめる段は、取らない（人の判断）                   | 退けた代案                         |                    |
| 3   | `forge-poll-budget` は、サーバのポーリングが無くなると狙いの大半が無くなる。扱いは人が決める | Why                                |                    |
| 4   | 人と決めた（2026-11-05）: `forge-poll-budget` は中止した                                   | Non-Goals（問い合わせの回数の削減） |                    |

## 動作確認の手順

`AI_BOARD_DATA` でスクラッチパッドの試しのデータのワークツリーを指して動かす（`.claude/skills/board-loop/rules.md` の「動かして確かめるとき」）。`config.yaml` の `github:` はこのリポジトリに向ける。

| 確かめること                                         | コマンド                                                         | 期待する結果                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ai-board`（引数なし）がサーバを起動しない           | `node dist/cli.js`                                               | 使い方が出て、終了コード 1。ポートを待ち受けない                                    |
| `ai-board --help` は使い方を出して 0 で終わる        | `node dist/cli.js --help`                                        | 使い方が出て、終了コード 0                                                          |
| `status` が動き、「サーバ:」の行が無い               | `node dist/cli.js status`                                        | 「GitHub:」「ループ:」の行と判断待ち・AI 作業中が出て、「サーバ:」の行が無い         |
| `status --only server` は使い方の誤りで拒まれる      | `node dist/cli.js status --json --only server`                   | 使い方が出て、終了コード 1                                                          |
| ダッシュボードの HTML を作れる                       | `node dist/cli.js status --html > board.html`                    | 終了コード 0 で HTML が出る                                                         |
| カードの起票と判断が今どおり書ける                   | `card create --title t --id a1` の後に `decide start a1`         | `a1: 着手 を書きました（アイデア → 計画提案中）`                                    |
| ビルドが画面を作らない                               | `npm run build && ls dist`                                       | `dist/web` が無い                                                                   |
| 消した依存が残っていない                             | `grep -rn "express\|react\|chokidar\|supertest\|vite" package.json src` | 何も出ない（`vitest` を除く）                                                       |

## タスク

### 1. 画面とサーバのコードを消す

- [x] `src/web/`、`vite.config.ts`、`tsconfig.web.json` を消し、`tsconfig*.json`・`eslint.config.js`・`vitest.config.ts` から `src/web` と `tsx` / `jsx` の記述を外す
- [x] `src/server.ts`、`src/app.ts`、`src/index.ts`、`src/board/controllers/`、`src/cards/controllers/`、`src/shared/controllers/`、`src/shared/middleware/` を、そのテストと一緒に消す
- [x] `src/infrastructure/` の `sse.ts`・`watch.ts`・`data-refresher.ts`・`open-browser.ts`・`server-info.ts` を、そのテストと一緒に消す
- [x] `ForgePoller` から `start` / `stop` / `intervalMs` / `DEFAULT_POLL_INTERVAL_MS` を消し、`forge-poller.test.ts` の定期実行のテストを外す
- [x] `src/cli-main.ts` で、引数なしの起動を「使い方を出して 1 で終わる」に変え、`--port` / `--no-open` / `--poll-interval` とサーバの起動を消す
- [x] `status` から `server` の項目と「サーバ:」の行を消し、`status-cli` のテストを合わせる
- [x] `package.json` から express・chokidar・react・react-dom・vite・@vitejs/plugin-react・supertest・tsx とその型を外し、`dev` / `dev:web` を消し、`build` を `tsc` だけに、`typecheck` から `tsconfig.web.json` を外し、`description` を直す。`package-lock.json` を `npm install` で作り直す

### 2. 使われなくなったコードを消す

- [x] controller だけが使っていた usecase と、そのエラーの型・テストを消す
- [x] `src/web/` だけが使っていた `src/shared/` の関数と型を、そのテストと一緒に消す
- [x] 消した結果どこからも import されなくなったモジュールが残っていないことを、`src/` の import を辿って確かめ、残っていれば消す

### 3. ドキュメントと仕様

- [x] `README.md` から画面・サーバの起動・詳細パネル・判断のボタンの説明を消し、ボードを `ai-board status`・ダッシュボード・チャットで扱う形に書き直す
- [x] `docs/architecture.md` から画面・HTTP API・SSE・ファイル監視・取り直し・ポーリングの節を消し、GitHub の取得を CLI の 1 回の `refresh()` の形に書き直す
- [x] `CLAUDE.md` の冒頭（ローカル Web ダッシュボード・`127.0.0.1:5673`）、書き込み境界の表の「ai-board サーバ」の行、`src/shared/` の決まり、テストの e2e と `src/web/` の記述を直す
- [x] `REVIEW.md` と `docs/specs/*/spec.md` の画面の記述を、`ai-board status` とダッシュボードの言葉に置き換える

### 4. ADR

- [ ] `adr` のスキルで、画面とサーバをいったん外した判断を `docs/adr/0017-remove-web-and-server.md` に書き、`docs/adr/README.md` の表に足す
- [ ] 画面に触れている ADR（0006 / 0007 / 0008 / 0009 / 0011 / 0015 / 0016）の画面とサーバの記述を、今の形に書き直す

### 5. 手順書

- [ ] `.claude/skills/board-loop/rules.md` から `server.json`・自分で起動したサーバ・人の API（`/api/...`）の記述を消す
- [ ] `.claude/skills/board-loop/plan.md` と `implement.md` の「見る画面」「画面の見た目」の例を、CLI で確かめられないものの例に置き換える
- [ ] `.claude/skills/board-decide/SKILL.md` と `.claude/skills/board-dashboard/SKILL.md` から画面のボタンとサーバの記述を消す
- [ ] `.claude/HARNESS_VERSIONS.md` に v2 を足し、画面とサーバを外して手順書から記述を消したことを書く
