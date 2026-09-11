---
id: vite-api-proxy
title: dev サーバの /api プロキシが api.ts を横取りする
created: '2026-09-10T23:28:21.734Z'
startedAt: null
skipGates: []
change: null
branch: fix-vite-api-proxy
mr: 3
---

## アイデア

`npm run dev:web` で開くボードが真っ白になる。Vite の proxy キー `/api` が前方一致で、
web 側のモジュール `/api.ts` まで Express へ転送していた。

## 調査メモ

- dev では `defaultWebDir()` が `src/web/index.html` の存在だけを見て `src/web` を静的配信に選ぶ。
  転送された `/api.ts` は TypeScript ソースのまま `Content-Type: video/mp2t` で 200 が返る
- ブラウザは module script として拒否し、`App.tsx` の import が解決できず `main.tsx` ごと落ちる。
  `#root` が空のまま残るので「真っ白」に見える
- `curl` では全モジュールが 200 に見えるため気づけない。判別点はレスポンスの `x-powered-by: Express`
- 本番ビルドに `/api.ts` は存在しないため `npm run dev:web` でのみ再現する

## 実装メモ

`^` 始まりの proxy キーは正規表現として扱われるので `'^/api(?:/|$)'` にした。MR !3。

## 残り

dev の Express（5673）が `src/web` を生で静的配信している件は未修正。
今回の不具合を 404 ではなく致命傷にしたのはこれ。別カードで扱う。
