---
id: node-lts
title: ユーザは、研修 PC に入れやすい Node の LTS（24）で ai-board を動かしたい
created: '2026-10-31T06:52:00.070Z'
skipGates:
  - plan
branch: null
mr: null
---

## アイデア

ai-board を Node の LTS（24）でも動くようにする。

- `package.json` の `engines` を 24 以上に広げ、CI のマトリクスに 24 と 26 を並べる
- `@types/node` は 24 系に合わせ、26 だけにある API を使っていないかを確かめる
- README の動かす前提を直す

## 背景

研修の受講者には、Node 26 を入れにくい人がいる（会社の PC で入れられる版が決まっている、など）。
直前に Node を 26 以上に絞ったのは、個人用のローカルツールとして CI と engines を揃えるためで、技術的な理由ではない。
カードの保存に使う `node:sqlite` は 24 でも使え、絞る前の CI は 22 / 24 / 26 で通っていた。
