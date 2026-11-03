# 12. ループに要る操作の許可ルールを allow / ask / deny の 3 段で同梱し、境界の本体にはしない

- 状態: 採用
- 日付: 2026-11-03

## 背景

ループの監視役とサブエージェントは 1 手のあいだに git・npm・`ai-board` の CLI を何度も呼ぶが、`.claude/settings.json` には deny しか無かった。
受講者は確認の応答に追われ、応答を待つ間ループは止まって見え、確認が多すぎると場当たりで何でも許しがちになる。
計画レビューでは、リベースしたブランチを push するために force push を許したいという否決があった。

## 決定

- **許可ルールを `allow`（毎手使い、PR とゲートで戻せる）/ `ask`（戻しにくく、人が 1 回だけ行う）/ `deny`（境界を壊す）の 3 段に分けて同梱する。**
  `allow` は手順書が実際に使う形（`node */dist/cli.js card` など）に合わせ、`gh` / `node -e` / `curl` / `git push` だけの形は書かない。
- **force push は `--force-with-lease` だけを `main` 以外へ許す。** `--force` / `-f` / `+` の refspec と `main` への push は `deny` に置き、
  `deny` の形は `--force` の後ろを空白か行の終わりで区切って `--force-with-lease` に当たらないようにする。
- **許可ルールはうっかりの事故を止める保険で、境界の本体ではない。** 本体はカードの CLI の構造、`board-decide` と人の API を使わない決まり、GitHub のブランチ保護に置く。
- 形は `src/__tests__/claude-settings.test.ts` で、`*` を任意の文字列とみなす照合の近似で守る。

## 結果

- 手順書の操作は確認なしで流れ、境界を壊す操作は確認を経ずに拒まれる。
- 手順書に操作を足すと確認が出る。危ない側には倒れないが、許可ルールの見直しが要る。
- 前方一致の照合なので `git -c x push --force` や `bash -c` で迂回できる。`main` の保護は人がブランチ保護で入れる必要がある。
- 手順書の push は `git -C "$WT" push origin <branch>` の明示の形に揃えた（上流が `origin/main` のまま `main` へ向かうのを避けるため）。
- auto モードの自動許可の判定とは別物で、`allow` にあっても判定が止めることはありうる。

## 退けた案

- **force push をすべて禁じる** — リベースした後の push が止まる（計画レビューの否決）。
- **戻しにくい操作も `deny` にする** — 人がチャットで頼んだ `git reset --hard` などの正当な操作まで止まる。
- **`gh` / `node -e` / `curl` を許す** — `node -e` は任意のコードを走らせられ、`curl` は人の API で人の判断を書ける。手順書は `ai-board pr` を使うので要らない。

根拠: `.ai-board/plans/loop-permissions.md`、PR #68
