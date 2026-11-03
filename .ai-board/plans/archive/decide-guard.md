# サブエージェントの中からは、人の判断を書く口（人の API と board-decide）を hook で拒む

## この計画で使う言葉

- **人の API**: ボードのサーバが持つ、人の判断を書く HTTP の口。`/api/cards`（作成・frontmatter の更新・本文・レビューの追記・並べ替え）と `/api/idea-divider`（区切り線の移動）。
  画面のボタンと、チャットから頼まれたときの `board-decide` のスキルが使う
- **サブエージェント**: ループの監視役が立てる `board-planner` / `board-worker` / `board-reviewer`。人ではない
- **hook**: Claude Code がツールを呼ぶ直前（`PreToolUse`）に走らせるコマンド。拒めば、そのツールの呼び出しは実行されない

## 提案

### Why

人の判断（承認 / 否決 / 中止、着手 / 着手を戻す、ゲートを飛ばす、並べ替え）を書く主体は「人と、人が会話で頼んだ Claude」である（ADR 0007）。
`ai-board card` の CLI は AI に承認を書かせない形で境界を構造として守っているが、人の API の側は
「サブエージェントは `board-decide` も人の API も使わない」という手順書の決まりだけに頼っている（`CLAUDE.md` に「技術的には止めていない」とある）。
認証の無い API なので、サブエージェントが手順書を破って Bash から `curl` を叩けば、承認も中止も書けてしまう。

指示は破られ得るが、仕組みで拒んだ操作は実行されない。研修で「HIL をどの部品が担っているか」を示すときにも、
人の API の側が手順書だけだと説明が弱い。そこで Claude Code の hook で、サブエージェントの中からの人の API と `board-decide` の呼び出しを拒む。

### What Changes

- サブエージェント（`board-planner` / `board-worker` / `board-reviewer`）の中から、次のツールの呼び出しが拒まれる
  - Bash で、コマンドに人の API の道（`/api/cards`、`/api/idea-divider`）を含むもの。承認・否決・中止・着手・`skipGates`・並べ替え・作成・本文の差し替えのすべて
  - Skill で、`board-decide` のスキルを呼ぶもの
- 拒んだときは、理由（「人の判断を書く口はサブエージェントからは使えない。人に頼むことは報告に書く」）がサブエージェントに返る
- 本筋のセッション（人がチャットで「〜を承認して」と頼む流れ、ループの監視役）は今のまま。確認も増えない
- `ai-board card` の CLI が AI に書かせない構造はそのまま残す。これは CLI の外の、人の API の側の穴を塞ぐもの
- 手順書・`CLAUDE.md`・README・ADR の「技術的には止めていない」を、今の形に書き直す

### Impact

- hook: `.claude/hooks/guard-human-api.mjs`（新規）
- サブエージェントの定義: `.claude/agents/board-planner.md` / `board-worker.md` / `board-reviewer.md` の frontmatter に `hooks` を足す
- テスト: `src/__tests__/claude-hooks.test.ts`（新規）
- 手順書・ドキュメント: `.claude/skills/board-loop/subagent-rules.md`、`CLAUDE.md`、`README.md`（ループの許可ルールの節）、`docs/architecture.md`、
  `docs/adr/0007-board-decide.md`、`docs/adr/0012-loop-permissions.md`
- サーバ・CLI・ステージの導出は変えない

## 設計

### Decisions

#### サブエージェントの中かは、hook の入力の `agent_id` で見分ける

Claude Code の hook の共通の入力には、サブエージェントの中で発火したときだけ `agent_id`（とエージェント名の `agent_type`）が載る
（公式の hooks のドキュメントの「common input fields」。本筋のセッションの入力には載らない）。
hook のスクリプトは `agent_id` が無ければ何もせず終わり、あるときだけ中身を調べて拒む。
環境変数などの目印をサブエージェントに渡す案は採らない（探索メモの 3）。

タスク 1.1 で、手元の Claude Code の版でこの欄が載ることを確かめてから作る。
確かめられなければ、目印や「全部を許可の ask にする」などの代案に自分で切り替えず、止まって人の判断を待つ（探索メモの 3）。

#### hook は 3 つのサブエージェントの定義の frontmatter に置く。`.claude/settings.json` には置かない

サブエージェントの定義（`.claude/agents/*.md`）の frontmatter の `hooks` は、そのサブエージェントが動いている間だけ効く。
`board-*` の 3 つに同じ hook を書き、スクリプトの本体は `.claude/hooks/guard-human-api.mjs` の 1 つにまとめる。

`.claude/settings.json` に置かない理由:

- `.claude/settings.json` は `deny` の `Edit(/.claude/settings*.json)` で AI の編集を止めている。許可や hook の設定を変えるのは人の領分で、
  この計画を進める `board-worker` が自分で書き換えるべきではない
- frontmatter の hook も、リポジトリの中のファイルなので、fork した研修のリポジトリにもそのまま入る（論点の「置き場所」の狙いは満たす）

スクリプトは frontmatter で範囲が絞られていても `agent_id` を見る。
範囲の絞り方が版によって変わっても、本筋のセッションを止めないようにするためである（二重の守り）。

#### 拒むのは人の API の書き込み全部。道（パス）で見分け、メソッドでは分けない

探索メモの 1 のとおり、承認・否決・中止に加えて、着手・`skipGates`・並べ替え（`rank` と区切り線）も拒む。
ハードルールの線（`startedAt` / `rank` / `skipGates` を書かない、承認 / 否決 / 中止 を書かない）と同じにする。

- Bash のコマンドの文字列に `/api/cards` か `/api/idea-divider` が含まれていれば拒む。大文字小文字は区別しない（Express の道の照合が既定で区別しないため）
- `curl -X POST` などのメソッドでは分けない。`--data` を付けると POST になる、`-XPOST` と詰めて書ける、`node -e` の `fetch` で叩ける、など書き方が多く、
  メソッドを見る照合は抜けやすい。道で拒めば、読み取り（`GET /api/cards`）も拒むことになるが、サブエージェントはカードを `ai-board card` の CLI で読むので困らない
- `/api/board`・`/api/health`・`/api/events` は拒まない。人の判断を書く口ではなく、自分で起動した試しのサーバを確かめるのに使える
- Skill のツールで `board-decide` を呼ぶもの（入力の `skill` が `board-decide`、プラグインの接頭辞が付いた形も含む）を拒む
- 拒み方は、標準出力に `hookSpecificOutput.permissionDecision: "deny"` の JSON を出して 0 で終わる形にする（理由を `permissionDecisionReason` に書く）
- スクリプトは `node` だけで動く `.mjs` にする。Windows の Git Bash でも動き、`jq` などを要らなくする（`windows-shell` の方針）。
  frontmatter の command は `node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-human-api.mjs"` とする
- 入力の JSON が読めない・想定外の形のときは、拒まずに通す（何もせず 0 で終わる）。hook の不具合でサブエージェントの全部のツールが止まるのを避ける。
  守りが外れるのは壊れた入力のときだけで、テストで形を固定する

#### 試しのサーバの人の API も、サブエージェントからは叩けなくなる

今の共通の決まりは「`AI_BOARD_DATA` で試しの clone を指して自分で起動したサーバを試すのは構わない」としている。
hook は道だけを見るので、試しのサーバの `/api/cards` も拒む。宛先のサーバで分けると、共有のサーバの URL を試しのサーバに見せかけるだけで抜けられる。
人の API の振る舞いは supertest の e2e（`src/cards/controllers/__tests__/` など）で確かめ、共通の決まりの文面もそれに合わせて直す。

### Risks

- **文字列の照合なので、わざと崩せば抜けられる。** 道を変数に分けて組み立てる、スクリプトをファイルに書いてから走らせる、URL を `%2F` で符号化する、など。
  この hook は「手順書を破って `board-decide` の `curl` をそのまま写す」ような破り方を止めるもので、わざと隠した呼び出しまでは止めない。
  破られても `## レビュー` に記録が残ることは今と同じで、ADR にこの限界を書く
- **frontmatter の hook は、作業フォルダの信頼の確認を受けた後にだけ効く**（公式のドキュメント）。ループを回すフォルダは信頼済みの前提である
- **hook の入力の形が版で変わる。** `agent_id` が載らなくなると、守りは黙って外れる（本筋を止めない側に倒している）。テストは入力の形の近似で、実際の発火は動作確認で人が見る
- **ループの監視役は止められない。** 監視役は本筋のセッションで動くので `agent_id` が載らない。Non-Goals を参照

### Trade-offs

- `.claude/settings.json` に置けば、`board-*` 以外のサブエージェント（`Explore` など）も含めて止められる。
  その代わり AI が許可の設定を書き換えることになるので採らない。広げたいときは、人が `.claude/settings.json` に同じスクリプトを 1 行足せば済む（スクリプトは `agent_id` を見るので本筋は止まらない）
- 道で拒むので、サブエージェントは試しのサーバでもカードの API を `curl` で確かめられない。e2e のテストで代える

### Non-Goals

- **同じゲートへの戻りの上限**（アイデアの箇条）。探索メモの 2 のとおり別のカードに分ける
- **ループの監視役を止めること。** 中止・承認にだけ人の確認（許可の ask）を足すかは別に決める
- サーバの側で人の API に認証を足すこと。ローカル専用ツールで、サブエージェントも同じ利用者として動くので、秘密を置いても読めてしまう
- `harness-guide` の案内を書くこと。この守りができた後に別に書く

## 動作確認の手順

1. このブランチをマージした後（frontmatter の hook はメインのチェックアウトの `.claude/agents/` から読まれる）、メインのチェックアウトで Claude Code を開き直す
2. 本筋のセッションで「`board-planner` のサブエージェントを立て、Bash で `curl -sS http://127.0.0.1:5673/api/cards/x/reviews -X POST` を走らせて結果をそのまま返させて」と頼む
   - 期待: サブエージェントの Bash は実行されず、「人の判断を書く口はサブエージェントからは使えない」の理由が返る
3. 同じサブエージェントに `node dist/cli.js status --json --only server` を走らせる
   - 期待: 拒まれずに走る（人の API を含まないコマンドは通る）
4. 同じサブエージェントに `board-decide` のスキルを呼ばせる
   - 期待: 拒まれる
5. 本筋のセッションで、`board-decide` で判断待ちの一覧（「判断待ちを見せて」）を頼む。サーバを起動して書くところまで試すなら、試しのカードで「着手して」を頼む
   - 期待: 今までどおり確認なしで進む

## タスク

### 1. hook を作ってサブエージェントに付ける

- [x] 手元の Claude Code の版（`claude --version`）と公式の hooks / subagents のドキュメントで、
      `PreToolUse` の入力にサブエージェントの中なら `agent_id` / `agent_type` が載ること、frontmatter の `hooks` がそのサブエージェントの間だけ効くことを確かめる。
      確かめられなければ、ここで止まり、代案に切り替えずに人の判断を待つと報告する（保留を CLI が受け付けるなら `--gate plan` で書く）
- [x] `.claude/hooks/guard-human-api.mjs` を書く。標準入力の JSON を読み、`agent_id` があり、
      Bash の `command` に `/api/cards` か `/api/idea-divider`（大文字小文字を区別しない）を含むか、Skill の `skill` が `board-decide`（`<plugin>:board-decide` も）なら、
      `permissionDecision: "deny"` の JSON を出す。それ以外と、読めない入力は何も出さずに 0 で終わる
- [x] `.claude/agents/board-planner.md` / `board-worker.md` / `board-reviewer.md` の frontmatter に、
      `PreToolUse` の matcher `Bash|Skill` で上のスクリプトを呼ぶ `hooks` を足す
- [x] `src/__tests__/claude-hooks.test.ts` を書く。スクリプトを `node` で起こして標準入力に JSON を渡し、次を確かめる
  - サブエージェントの中の `curl ... /api/cards/<id>/reviews`（POST）、`PATCH /api/cards/<id>`、`/api/cards/<id>/move`、`/api/idea-divider/move`、`fetch` で叩く `node -e`、大文字の道は拒む
  - サブエージェントの中の `ai-board card submit`、`status --json`、`curl .../api/board` は通す
  - サブエージェントの中の Skill の `board-decide` は拒み、ほかのスキルは通す
  - `agent_id` の無い入力（本筋）は、同じコマンドでも通す
  - 壊れた JSON は通す
  - 3 つの定義の frontmatter（`gray-matter` で読む）に同じ hook が書かれている
- [x] `.claude/hooks/*.mjs` が lint / format の対象でどう扱われるかを確かめ、品質ゲートが通る形にする（対象外なら対象外のままでよい）

### 2. 手順書とドキュメントを今の形に書き直す

- [x] `.claude/skills/board-loop/subagent-rules.md` のハードルールに、人の API と `board-decide` は hook でも拒まれることと、
      試しのサーバでもカードの API（`/api/cards`・`/api/idea-divider`）は叩けないので e2e で確かめることを書く
- [x] `CLAUDE.md` の「手順書の決まりで、技術的には止めていない」を、サブエージェントは hook で拒み、監視役は手順書の決まりで守る、に直す
- [x] `README.md` のループの許可ルールの節（境界の本体の行）と、`docs/architecture.md` に hook の置き場所と拒む範囲を書く
- [x] `docs/adr/0007-board-decide.md` の決定・結果・退けた案を今の形に書き直す（サブエージェントは hook で拒む、監視役は決まり、文字列の照合の限界、`.claude/settings.json` に置かない理由）。
      `docs/adr/0012-loop-permissions.md` の「境界の本体」の行も合わせる

## AI レビュー

### 見送った指摘

- `.claude/skills/board-loop/subagent-rules.md:152` は「自分で起動したサーバを試すのは構わない」と書いた直後に「試しのサーバでもカードの API は叩けない」と続き、一読では食い違って見える。直後の文で範囲（`/api/board`・`/api/health`・`/api/events` は叩ける）が読み取れ、振る舞いに関わらない言い回しなので見送る

### 人に判断してほしいこと

- `.claude/hooks/guard-human-api.mjs:12` の `HUMAN_API_PATTERN` はコマンドの文字列全体を照合するので、人の API を叩かず道の文字列を含むだけの Bash も拒む。例: `grep -rn "/api/cards" src/`、`git commit -m "docs: /api/cards の…"`、ヒアドキュメントで `/api/cards` を含む文書やPR の本文を書くコマンド。計画の Decisions は「道で拒むので読み取りも拒む」までは受け入れているが、この種の巻き添えには触れていない。拒んだときの理由（`REASON`）も「道の文字列を含むだけで拒む」ことを言わないので、サブエージェントが理由を取り違えて止まりうる。（a）このまま受け入れ、`REASON` に「道の文字列を含むだけのコマンドも拒む。検索は Grep のツールを使い、コミットや本文の文面は道を書かずに言い換える」と足す、（b）`curl` / `fetch` / `wget` などの送る形に絞って照合する（Decisions の「メソッドや書き方で分けると抜けやすい」とぶつかる）、のどちらにするかは人が決める
