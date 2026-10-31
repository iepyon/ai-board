# board-timeline Specification

## Purpose

カードが各工程にいた時間を、残った痕跡から区間の並びとして導出する。
どの工程で、人と AI のどちらを待って時間を使ったかを後から見られるようにする。

## Requirements

### Requirement: 各工程にいた時間は区間の並びとして導出する

システムは カードが各工程にいた時間を、区間の並びとして示さなければならない (MUST)。
区間は種類・担当（人 / AI）・始まり・終わりを持ち、時刻の順に並ぶ。
区間の並びはステージと同じく保存しては SHALL NOT、残った痕跡から毎回導出しなければならない (MUST)。
導出は今の時刻を受け取っては SHALL NOT。同じ痕跡からは常に同じ並びを返す。

痕跡は、起票の時刻、着手の時刻、`## レビュー` のすべてのエントリ、PR を最後に Ready にした時刻・
最後に Draft へ戻した時刻・マージした時刻である。
`## レビュー` は今効いている判断だけでなく、すべてのエントリを時刻の順に読まなければならない (MUST)。
差し戻しの前のエントリこそが区間の境目になるからである。

区間の種類と担当は次の 12 種類とする。

| 種類             | 区間             | 担当 | 始まり                                 |
| ---------------- | ---------------- | ---- | -------------------------------------- |
| `idea`           | アイデアの滞留   | 人   | 起票                                   |
| `planning`       | 計画を書く       | AI   | 着手                                   |
| `plan-review`    | 計画レビュー     | 人   | plan 提出 / 再提出                     |
| `plan-rework`    | 計画の差し戻し   | AI   | plan 否決                              |
| `plan-held`      | 計画の保留       | 人   | plan 保留                              |
| `implementing`   | 実装             | AI   | plan 承認（plan を飛ばすカードは着手） |
| `verifying`      | 動作確認         | 人   | verify 提出 / 再提出                   |
| `verify-rework`  | 実装の差し戻し   | AI   | verify 否決                            |
| `verify-held`    | 実装の保留       | 人   | verify 保留                            |
| `readying`       | Ready にする     | AI   | verify 承認                            |
| `pr-review`      | PR レビュー      | 人   | PR を Ready にした                     |
| `draft-returned` | Draft に戻された | 人   | PR を Draft に戻した                   |

区間の終わりは次の区間の始まりとする。マージと中止は今の区間を閉じるだけで、次の区間を始めない。
今いる区間は終わりを持たない。マージ済み・中止のカードは、終わりを持たない区間を持っては SHALL NOT。
長さ 0 の区間は落とし、同じ種類の区間が隣り合ったら 1 つにつながなければならない (MUST)。

PR を最後に Ready にした時刻は、PR のイベントの最後の Ready から取る。
作成時から Ready の PR はそのイベントを残さないので、Draft でない PR でイベントが無ければ PR の作成時刻とする。
今 Draft で一度も Ready にしていない PR は、Ready にした時刻を持たない。

#### Scenario: アイデアのまま

- **WHEN** 着手されていないカードを見る
- **THEN** 区間は起票から始まる `idea` の 1 つだけで、終わりを持たない

#### Scenario: 計画の否決と再提出

- **WHEN** plan が提出・否決・再提出・承認され、PR が Ready になってマージされた
- **THEN** 区間は `idea` → `planning` → `plan-review` → `plan-rework` → `plan-review` → `implementing` → … と並び、
  最後の `pr-review` はマージの時刻で閉じる

#### Scenario: 計画から立て直させた

- **WHEN** 承認済みの計画に plan の否決が記録され、計画が再提出されて承認し直された
- **THEN** `implementing` は否決の時刻で閉じて `plan-rework` が始まり、承認し直した時刻から再び `implementing` が始まる

#### Scenario: 否決を挟まずに再提出した

- **WHEN** verify の提出の後に、否決を挟まず verify の再提出が記録され、その後承認された
- **THEN** `verifying` は提出から承認までの 1 区間につながる

#### Scenario: 動作確認の承認より先に Ready になった

- **WHEN** 人が verify の承認より前に GitHub で PR を Ready にし、その後 Draft に戻されずに承認された
- **THEN** `readying` は現れず、Ready にした時刻から `pr-review` が始まる

#### Scenario: 着手のボタンを押さずに進めた

- **WHEN** 着手時刻が無い、または最初の `## レビュー` のエントリより後にあるカードを見る
- **THEN** 着手時刻は無いものとして扱われ、`idea` が最初のエントリまで続き、`planning` は現れない

#### Scenario: GitHub につながっていない

- **WHEN** PR の Ready・マージの時刻が引けないカードで、最後の記録が verify の承認である
- **THEN** 最後の `readying` は終わりを持たないまま残る
