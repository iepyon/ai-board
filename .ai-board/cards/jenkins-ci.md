---
id: jenkins-ci
title: Jenkins を導入して品質ゲートを CI で回す
created: '2026-09-04T06:48:23.402Z'
explored: false
implStartedAt: null
change: null
branch: null
mr: null
stageOverride: null
---

## アイデア

ローカルの品質ゲートは `--no-verify` で迂回できる。CI を最後の砦として置きたい。

決めること: Jenkins の立て方（Docker か既存か）、GitLab との連携方法、実行内容（test / lint / typecheck / build）、失敗時の通知先。
