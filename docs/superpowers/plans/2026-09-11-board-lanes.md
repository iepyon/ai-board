# ボードのレーン再設計 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ボードの列を 7 段から HIL ゲート付きの 9 段へ作り直し、人の判断（着手・承認・否決・中止）をカード本文のレビューログという実態として記録したうえで、ステージを純関数の出力として導出しつづける。

**Architecture:** カード本文の `## レビュー` セクションを追記専用ログとして解釈する純関数（`review-log.ts`）を新設し、`stage-resolver.ts` の `RULES` 配列がそれを入力に取る。`stage` は今までどおりどこにも保存しない。人の操作面はドラッグ 1 遷移＋レビューボタンへ縮み、`stageOverride` は削除される。

**Tech Stack:** TypeScript (ESM, Node >= 20) / Express 5 / React 19 + Vite / Vitest / Zod / gray-matter

**Spec:** `docs/superpowers/specs/2026-09-11-board-lanes-design.md`

## Global Constraints

- 品質ゲートは `npm run typecheck && npm run lint && npm test`。コミット前に必ず全部通す。`typecheck` は tsc を 2 回走らせる（サーバと web）。
- サーバ側は `module: NodeNext`。相対 import に `.js` 拡張子が必須（`./card.js`）。パスエイリアスは使わない。
- `src/shared/` は両方の tsconfig に含まれる。Node 専用 API を持ち込まない。
- usecase は例外を投げず `Result<T, E>` を返す（`src/shared/result.ts`）。
- エラーは discriminated union。controller が `*-error-mappings.ts` の `switch` で HTTP ステータスへ変換する。
- 依存はコンテキストごとの `composition.ts` で構成する。usecase やリポジトリの中で `new` しない。
- ID は Branded Type。生の string を渡さず `createCardId` などのファクトリを通す。
- 入力検証は Zod（`models/schemas/`）。`PATCH` では `undefined`（変更しない）と `null`（値を消す）を区別する。
- テストは `src/**/__tests__/**/*.test.ts` に置く。この glob 外は vitest が黙って無視する。
- `src/web/` は vitest の対象外。UI の変更は typecheck と lint で担保する。
- ESLint: `complexity: 12` / `max-lines-per-function: 120` / 型は `import type` / `no-console`（`warn` と `error` のみ許可）。
- 両方の tsconfig で `strict` + `noUncheckedIndexedAccess`。配列アクセスは `undefined` を考慮する。
- コミットは日本語の Conventional Commits。末尾に `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` を付ける。
- 作業ブランチは `board-lanes`。

## ファイル構成

**新規**

| ファイル | 責務 |
|---|---|
| `src/cards/models/review.ts` | `ReviewGate` / `ReviewKind` / `ReviewEntry` / `GateState` の型定義 |
| `src/cards/services/review-log.ts` | 本文の `## レビュー` セクションの解析と追記（純関数のみ） |
| `src/cards/services/__tests__/review-log.test.ts` | 上のテスト |
| `src/cards/usecases/commands/append-review.command.ts` | レビューエントリ追記ユースケース |
| `src/web/components/detail/ReviewActions.tsx` | 承認 / 否決 / 中止のボタンと理由入力 |

**削除**

| ファイル | 理由 |
|---|---|
| `src/web/components/detail/ProgressActions.tsx` | `explored` / `implStartedAt` の操作 UI。`ReviewActions.tsx` が置き換える |

**変更**

| ファイル | 変更内容 |
|---|---|
| `src/shared/schemas/common.ts` | `STAGES` を 9 段へ入れ替え |
| `src/cards/models/card.ts` | `explored` / `implStartedAt` / `stageOverride` を削除、`startedAt` / `skipGates` を追加 |
| `src/cards/models/schemas/card.schema.ts` | 同上。`UpdateCardMetaInputSchema` から `stageOverride` を削除 |
| `src/cards/repositories/fs-card.repository.ts` | `serializeCard` / `toCard` のフィールド差し替え |
| `src/cards/composition.ts` | `appendReviewCommand` を追加 |
| `src/cards/controllers/card.controller.ts` | `POST /:id/reviews` を追加、`toCardResponse` の差し替え |
| `src/board/services/stage-resolver.ts` | `RULES` の全面差し替え、`HUMAN_STAGES` の縮小、`hasFixAfterReview` を export |
| `src/board/models/board-card.ts` | `overridden` / `diverged` / `stageOverride` / `explored` / `implStartedAt` を削除、`aborted` / `gates` / `startedAt` / `skipGates` / `mrState.resubmitted` を追加 |
| `src/board/usecases/queries/get-board.query.ts` | `toBoardCard` 呼び出しの差し替え |
| `src/web/types.ts` | `Stage` / `STAGE_LABELS` / `STAGE_SOURCE` / `HUMAN_STAGES` / `BoardCard` |
| `src/web/api.ts` | `CardMetaPatch` の差し替え、`appendReview` の追加 |
| `src/web/components/Board.tsx` | `patchForStage` を 2 列へ縮小、`stageOverride` の解除処理を削除 |
| `src/web/components/Column.tsx` | HIL 列の表示（🔒 の付け方を変える） |
| `src/web/components/CardBadges.tsx` | `diverged` バッジの削除、再提出バッジの追加 |
| `src/web/components/CardDetail.tsx` | `ProgressActions` → `ReviewActions` |
| `src/web/components/detail/StageSection.tsx` | 上書き関連の削除 |
| `src/web/App.tsx` | 中止カードの折り畳み |
| `CLAUDE.md` / `README.md` / `.ai-board/cards/board-loop-skill.md` | ステージ導出の節と AI のハードルール |
| `.ai-board/cards/*.md` | frontmatter の移行 |

---

### Task 1: レビューログの型と解析

**Files:**
- Create: `src/cards/models/review.ts`
- Create: `src/cards/services/review-log.ts`
- Test: `src/cards/services/__tests__/review-log.test.ts`

**Interfaces:**
- Consumes: なし（このタスクが最初）
- Produces:
  - `type ReviewGate = 'explore' | 'plan'`
  - `type ReviewKind = '提出' | '再提出' | '承認' | '否決' | '中止'`
  - `interface ReviewEntry { readonly at: string; readonly gate: ReviewGate; readonly kind: ReviewKind; readonly reason: string }`
  - `type GateState = 'none' | 'submitted' | 'approved' | 'rejected'`
  - `parseReviewLog(body: string): ReviewEntry[]`
  - `gateState(entries: readonly ReviewEntry[], gate: ReviewGate, skipGates: readonly ReviewGate[]): GateState`
  - `isAborted(entries: readonly ReviewEntry[]): boolean`
  - `hasExploreNote(body: string): boolean`

- [ ] **Step 1: 型定義ファイルを書く**

`src/cards/models/review.ts`:

```ts
// ============================================================
// レビューログ — 人の判断を残す唯一の場所
// ============================================================

/**
 * 人が判断するゲート。
 *
 * `pr` ゲートはここに含めない。PR の承認は GitLab 側の実態
 * （MR が merged になること）そのものであり、カード本文には現れないため。
 */
export const REVIEW_GATES = ['explore', 'plan'] as const;

export type ReviewGate = (typeof REVIEW_GATES)[number];

/** レビューエントリの種別。提出 / 再提出は AI、それ以外は人が書く */
export const REVIEW_KINDS = ['提出', '再提出', '承認', '否決', '中止'] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface ReviewEntry {
  /** ISO 8601 文字列 */
  readonly at: string;
  readonly gate: ReviewGate;
  readonly kind: ReviewKind;
  /** 見出しに続く本文。理由が書かれていなければ空文字 */
  readonly reason: string;
}

/** ゲートの通過状況。ステージ導出の入力になる */
export type GateState = 'none' | 'submitted' | 'approved' | 'rejected';

export function isReviewGate(value: string): value is ReviewGate {
  return (REVIEW_GATES as readonly string[]).includes(value);
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/cards/services/__tests__/review-log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  gateState,
  hasExploreNote,
  isAborted,
  parseReviewLog,
} from '../review-log.js';
import type { ReviewEntry } from '../../models/review.js';

const BODY_WITH_LOG = `## アイデア

なにかする。

## 探索メモ

- 既存の stage-resolver を読んだ

## レビュー

### 2026-09-11T04:00:00.000Z explore 提出

### 2026-09-11T05:12:00.000Z explore 否決

既存の stage-resolver を見ていない。
導出ルールとの整合を調べ直して。

### 2026-09-11T09:30:00.000Z explore 再提出
`;

describe('parseReviewLog', () => {
  it('## レビュー セクションのエントリを時系列で返す', () => {
    const entries = parseReviewLog(BODY_WITH_LOG);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual<ReviewEntry>({
      at: '2026-09-11T04:00:00.000Z',
      gate: 'explore',
      kind: '提出',
      reason: '',
    });
  });

  it('見出しに続く本文を理由として拾う', () => {
    const entries = parseReviewLog(BODY_WITH_LOG);

    expect(entries[1]?.reason).toBe(
      '既存の stage-resolver を見ていない。\n導出ルールとの整合を調べ直して。'
    );
  });

  it('## レビュー が無い本文では空配列を返す', () => {
    expect(parseReviewLog('## アイデア\n\nなにかする。')).toEqual([]);
  });

  it('別の h2 が来たらセクションを打ち切る', () => {
    const body = `## レビュー

### 2026-09-11T04:00:00.000Z explore 提出

## 参考

### 2026-09-11T05:00:00.000Z plan 承認
`;

    expect(parseReviewLog(body)).toHaveLength(1);
  });

  it('書式の壊れた見出しは黙って無視する', () => {
    const body = `## レビュー

### これは見出しではない
### 2026-09-11T04:00:00.000Z unknown 提出
### not-a-date explore 提出
### 2026-09-11T04:00:00.000Z explore 承認
`;

    const entries = parseReviewLog(body);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('承認');
  });
});

describe('gateState', () => {
  const entries = parseReviewLog(BODY_WITH_LOG);

  it('エントリが無ければ none', () => {
    expect(gateState([], 'explore', [])).toBe('none');
  });

  it('最新が 再提出 なら submitted', () => {
    expect(gateState(entries, 'explore', [])).toBe('submitted');
  });

  it('最新が 否決 なら rejected', () => {
    expect(gateState(entries.slice(0, 2), 'explore', [])).toBe('rejected');
  });

  it('最新が 承認 なら approved', () => {
    const approved: ReviewEntry[] = [
      ...entries,
      { at: '2026-09-11T09:45:00.000Z', gate: 'explore', kind: '承認', reason: '' },
    ];

    expect(gateState(approved, 'explore', [])).toBe('approved');
  });

  it('他のゲートのエントリは混ざらない', () => {
    expect(gateState(entries, 'plan', [])).toBe('none');
  });

  it('skipGates に含まれていればエントリを見ずに approved', () => {
    expect(gateState(entries.slice(0, 2), 'explore', ['explore'])).toBe('approved');
  });

  it('時刻の並びが逆でも最新の時刻のものを採る', () => {
    const shuffled: ReviewEntry[] = [
      { at: '2026-09-11T09:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '否決', reason: 'だめ' },
    ];

    expect(gateState(shuffled, 'plan', [])).toBe('approved');
  });
});

describe('isAborted', () => {
  it('最新のエントリが 中止 なら true', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'explore', kind: '承認', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
    ];

    expect(isAborted(entries)).toBe(true);
  });

  it('中止のあとに別のエントリがあれば false', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'plan', kind: '再提出', reason: '' },
    ];

    expect(isAborted(entries)).toBe(false);
  });

  it('エントリが無ければ false', () => {
    expect(isAborted([])).toBe(false);
  });
});

describe('hasExploreNote', () => {
  it('## 探索メモ があれば true', () => {
    expect(hasExploreNote(BODY_WITH_LOG)).toBe(true);
  });

  it('無ければ false', () => {
    expect(hasExploreNote('## アイデア\n\nなにかする。')).toBe(false);
  });

  it('見出しでない行に同じ文字列があっても false', () => {
    expect(hasExploreNote('探索メモを書く予定')).toBe(false);
  });
});
```

- [ ] **Step 3: テストを走らせて失敗を確認する**

Run: `npx vitest run src/cards/services/__tests__/review-log.test.ts`
Expected: FAIL（`Cannot find module '../review-log.js'`）

- [ ] **Step 4: 実装を書く**

`src/cards/services/review-log.ts`:

```ts
import {
  isReviewGate,
  isReviewKind,
  type GateState,
  type ReviewEntry,
  type ReviewGate,
} from '../models/review.js';

// ============================================================
// レビューログの解析 — 純関数のみ。I/O は持たない
// ============================================================

const REVIEW_HEADING = '## レビュー';
const EXPLORE_NOTE_HEADING = '## 探索メモ';

/** `### <ISO8601> <gate> <種別>` */
const ENTRY_HEADING = /^###\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

/**
 * 本文の `## レビュー` セクションを解析する。
 *
 * 書式の壊れた見出しは黙って無視する。カードは人が直接編集してよいファイルであり、
 * 手書きの揺れでボード全体が読めなくなるほうが害が大きいため。
 */
export function parseReviewLog(body: string): ReviewEntry[] {
  const section = extractSection(body, REVIEW_HEADING);
  if (section === null) return [];

  const entries: ReviewEntry[] = [];
  let pending: { at: string; gate: ReviewGate; kind: ReviewEntry['kind'] } | null = null;
  let reasonLines: string[] = [];

  const flush = (): void => {
    if (pending === null) return;
    entries.push({ ...pending, reason: reasonLines.join('\n').trim() });
    pending = null;
    reasonLines = [];
  };

  for (const line of section) {
    const match = ENTRY_HEADING.exec(line);

    if (match === null) {
      if (pending !== null) reasonLines.push(line);
      continue;
    }

    flush();
    pending = toPending(match);
  }

  flush();

  return entries;
}

/** 正規表現のキャプチャを検証済みのエントリ見出しへ変換する。不正なら null */
function toPending(
  match: RegExpExecArray
): { at: string; gate: ReviewGate; kind: ReviewEntry['kind'] } | null {
  const [, at, gate, kind] = match;

  if (at === undefined || gate === undefined || kind === undefined) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  if (!isReviewGate(gate)) return null;
  if (!isReviewKind(kind)) return null;

  return { at, gate, kind };
}

/**
 * 指定した h2 見出しの中身を行の配列で返す。次の h2 で打ち切る。
 * 見出しが無ければ null。
 */
function extractSection(body: string, heading: string): string[] | null {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);

  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));

  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * ゲートの通過状況。
 *
 * `skipGates` に宣言されたゲートはログを見ずに通過扱いにする。
 * 人が事前に「このカードのこのゲートは見ない」と決めた意思表示だからである。
 */
export function gateState(
  entries: readonly ReviewEntry[],
  gate: ReviewGate,
  skipGates: readonly ReviewGate[]
): GateState {
  if (skipGates.includes(gate)) return 'approved';

  const latest = latestOf(entries.filter((entry) => entry.gate === gate));
  if (latest === null) return 'none';

  switch (latest.kind) {
    case '承認':
      return 'approved';
    case '否決':
      return 'rejected';
    case '提出':
    case '再提出':
      return 'submitted';
    case '中止':
      // 中止は列ではなく終端フラグで表す。ゲートの状態は動かさない
      return 'none';
  }
}

/** 全エントリを通じて最新のものが 中止 か */
export function isAborted(entries: readonly ReviewEntry[]): boolean {
  return latestOf(entries)?.kind === '中止';
}

/** 本文に `## 探索メモ` 見出しがあるか＝探索の成果物が出ているか */
export function hasExploreNote(body: string): boolean {
  return extractSection(body, EXPLORE_NOTE_HEADING) !== null;
}

/** 時刻が最も新しいエントリ。同時刻なら後に書かれたほうを採る */
function latestOf(entries: readonly ReviewEntry[]): ReviewEntry | null {
  let latest: ReviewEntry | null = null;

  for (const entry of entries) {
    if (latest === null || Date.parse(entry.at) >= Date.parse(latest.at)) {
      latest = entry;
    }
  }

  return latest;
}
```

`toPending` が `null` を返す経路を `parseReviewLog` が握り潰していないか注意する。`flush()` の直後に `pending = toPending(match)` を代入しており、`null` なら以降の行は理由として拾われずに捨てられる。これは意図した挙動（壊れた見出しは無視）。

- [ ] **Step 5: テストを走らせて通ることを確認する**

Run: `npx vitest run src/cards/services/__tests__/review-log.test.ts`
Expected: PASS

- [ ] **Step 6: 品質ゲートを通してコミット**

```bash
npm run typecheck && npm run lint && npm test
git add src/cards/models/review.ts src/cards/services/review-log.ts src/cards/services/__tests__/review-log.test.ts
git commit -m "$(cat <<'MSG'
feat: カード本文のレビューログを解析する純関数を足す

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: レビューログへの追記

**Files:**
- Modify: `src/cards/services/review-log.ts`
- Test: `src/cards/services/__tests__/review-log.test.ts:末尾に追加`

**Interfaces:**
- Consumes: Task 1 の `ReviewEntry`
- Produces: `appendReviewEntry(body: string, entry: ReviewEntry): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/cards/services/__tests__/review-log.test.ts` の末尾に追加:

```ts
describe('appendReviewEntry', () => {
  const entry: ReviewEntry = {
    at: '2026-09-11T09:45:00.000Z',
    gate: 'explore',
    kind: '承認',
    reason: '',
  };

  it('## レビュー が無ければセクションごと作る', () => {
    const result = appendReviewEntry('## アイデア\n\nなにかする。\n', entry);

    expect(result).toBe(
      '## アイデア\n\nなにかする。\n\n## レビュー\n\n### 2026-09-11T09:45:00.000Z explore 承認\n'
    );
  });

  it('既存のセクションの末尾に足す', () => {
    const body = '## レビュー\n\n### 2026-09-11T04:00:00.000Z explore 提出\n';

    expect(appendReviewEntry(body, entry)).toBe(
      '## レビュー\n\n### 2026-09-11T04:00:00.000Z explore 提出\n\n### 2026-09-11T09:45:00.000Z explore 承認\n'
    );
  });

  it('理由があれば見出しの下に置く', () => {
    const rejected: ReviewEntry = {
      at: '2026-09-11T05:12:00.000Z',
      gate: 'plan',
      kind: '否決',
      reason: 'スコープが広すぎる',
    };

    expect(appendReviewEntry('', rejected)).toBe(
      '## レビュー\n\n### 2026-09-11T05:12:00.000Z plan 否決\n\nスコープが広すぎる\n'
    );
  });

  it('## レビュー の後ろに別のセクションがあってもその手前に足す', () => {
    const body = '## レビュー\n\n### 2026-09-11T04:00:00.000Z explore 提出\n\n## 参考\n\nリンク\n';

    expect(appendReviewEntry(body, entry)).toBe(
      '## レビュー\n\n### 2026-09-11T04:00:00.000Z explore 提出\n\n### 2026-09-11T09:45:00.000Z explore 承認\n\n## 参考\n\nリンク\n'
    );
  });

  it('追記した結果を parseReviewLog が読み戻せる', () => {
    const result = appendReviewEntry(BODY_WITH_LOG, entry);
    const entries = parseReviewLog(result);

    expect(entries).toHaveLength(4);
    expect(entries[3]).toEqual(entry);
    expect(gateState(entries, 'explore', [])).toBe('approved');
  });
});
```

import 文に `appendReviewEntry` を足す:

```ts
import {
  appendReviewEntry,
  gateState,
  hasExploreNote,
  isAborted,
  parseReviewLog,
} from '../review-log.js';
```

- [ ] **Step 2: テストを走らせて失敗を確認する**

Run: `npx vitest run src/cards/services/__tests__/review-log.test.ts -t appendReviewEntry`
Expected: FAIL（`appendReviewEntry is not a function`）

- [ ] **Step 3: 実装を書く**

`src/cards/services/review-log.ts` の末尾に追加:

```ts
/**
 * レビューエントリを本文へ追記する。
 *
 * `## レビュー` が無ければ本文の末尾にセクションごと作る。
 * あればそのセクションの末尾（次の h2 の手前）へ足す。
 */
export function appendReviewEntry(body: string, entry: ReviewEntry): string {
  const block = renderEntry(entry);
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === REVIEW_HEADING);

  if (start === -1) {
    const head = body.trimEnd();
    const prefix = head === '' ? '' : `${head}\n\n`;
    return `${prefix}${REVIEW_HEADING}\n\n${block}`;
  }

  const rest = lines.slice(start + 1);
  const offset = rest.findIndex((line) => line.startsWith('## '));

  if (offset === -1) {
    return `${body.trimEnd()}\n\n${block}`;
  }

  const before = lines.slice(0, start + 1 + offset).join('\n').trimEnd();
  const after = lines.slice(start + 1 + offset).join('\n');

  return `${before}\n\n${block}\n${after}`;
}

/** エントリ 1 件の Markdown 表現。末尾に改行を 1 つ持つ */
function renderEntry(entry: ReviewEntry): string {
  const heading = `### ${entry.at} ${entry.gate} ${entry.kind}\n`;

  return entry.reason === '' ? heading : `${heading}\n${entry.reason}\n`;
}
```

- [ ] **Step 4: テストを走らせて通ることを確認する**

Run: `npx vitest run src/cards/services/__tests__/review-log.test.ts`
Expected: PASS

- [ ] **Step 5: 品質ゲートを通してコミット**

```bash
npm run typecheck && npm run lint && npm test
git add src/cards/services/
git commit -m "$(cat <<'MSG'
feat: レビューエントリを本文へ追記する関数を足す

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: カードスキーマの入れ替え

**Files:**
- Modify: `src/cards/models/card.ts`
- Modify: `src/cards/models/schemas/card.schema.ts`
- Modify: `src/cards/repositories/fs-card.repository.ts`
- Modify: `src/cards/usecases/commands/create-card.command.ts`
- Test: `src/cards/repositories/__tests__/fs-card.repository.test.ts`
- Test: `src/cards/usecases/__tests__/card-commands.test.ts`

**Interfaces:**
- Consumes: Task 1 の `ReviewGate`
- Produces: 新しい `Card`
  ```ts
  interface Card {
    readonly id: CardId;
    readonly title: string;
    readonly created: string;
    readonly startedAt: string | null;
    readonly skipGates: readonly ReviewGate[];
    readonly change: ChangeName | null;
    readonly branch: string | null;
    readonly mr: MergeRequestIid | null;
    readonly body: string;
  }
  ```

このタスクを終えるまで `stage-resolver.ts` と `board-card.ts` は型エラーを出す。Task 4 と 5 で解消する。**このタスク単体では `npm run typecheck` は通らない。** Step 5 の指示に従うこと。

- [ ] **Step 1: 既存テストを新スキーマへ書き換える（失敗する状態にする）**

`src/cards/repositories/__tests__/fs-card.repository.test.ts` と `src/cards/usecases/__tests__/card-commands.test.ts` の中で、

- `explored: false` → `startedAt: null, skipGates: []`
- `explored: true` → `startedAt: '<ISO 文字列>', skipGates: []`
- `implStartedAt: <値>` → 削除
- `stageOverride: null` → 削除

へ機械的に置換する。加えて `fs-card.repository.test.ts` に次のテストを足す:

```ts
it('skipGates を配列として往復できる', async () => {
  const card: Card = {
    id: 'skip-gates' as CardId,
    title: 'ゲートを飛ばす',
    created: '2026-09-11T00:00:00.000Z',
    startedAt: '2026-09-11T01:00:00.000Z',
    skipGates: ['explore', 'plan'],
    change: null,
    branch: null,
    mr: null,
    body: '## アイデア\n',
  };

  await repository.create(card);

  const loaded = await repository.findById('skip-gates' as CardId);
  expect(loaded?.skipGates).toEqual(['explore', 'plan']);
  expect(loaded?.startedAt).toBe('2026-09-11T01:00:00.000Z');
});

it('skipGates が無い既存ファイルは空配列として読む', async () => {
  await fs.writeFile(
    path.join(cardsDir, 'legacy.md'),
    '---\nid: legacy\ntitle: 古いカード\ncreated: 2026-09-01T00:00:00.000Z\n---\n\n本文\n',
    'utf-8'
  );

  const loaded = await repository.findById('legacy' as CardId);
  expect(loaded?.skipGates).toEqual([]);
  expect(loaded?.startedAt).toBeNull();
});
```

- [ ] **Step 2: テストを走らせて失敗を確認する**

Run: `npx vitest run src/cards/`
Expected: FAIL（`skipGates` が `undefined`、型エラー）

- [ ] **Step 3: `card.ts` を書き換える**

```ts
import type { CardId, ChangeName, MergeRequestIid } from '../../shared/schemas/common.js';
import type { ReviewGate } from './review.js';

// ============================================================
// カード — アイデアから マージ済み までを貫く唯一の join テーブル
// ============================================================

/**
 * カードは `.ai-board/cards/<id>.md` の 1 ファイルに対応する。
 *
 * `id` は不変で、`change` / `branch` / `mr` が進行に応じて後から埋まる。
 * カードは全ステージを通じて存在し続ける（マージ済みでも削除しない）ため、
 * アイデアメモ → change → ブランチ → MR → archive を 1 本の線でつなげる。
 *
 * ステージそのものは保存しない。`startedAt` と本文のレビューログ、
 * および openspec / GitLab の実態から純関数で導出する。
 */
export interface Card {
  readonly id: CardId;
  readonly title: string;
  /** ISO 8601 文字列 */
  readonly created: string;
  /** 人が探索の着手を指示した時刻。null ならアイデア列に留まる */
  readonly startedAt: string | null;
  /** 人が事前に「見ない」と宣言したゲート。AI はここで止まらない */
  readonly skipGates: readonly ReviewGate[];
  readonly change: ChangeName | null;
  readonly branch: string | null;
  readonly mr: MergeRequestIid | null;
  /** frontmatter を除いた Markdown 本文。レビューログと探索メモを含む */
  readonly body: string;
}
```

- [ ] **Step 4: `card.schema.ts` を書き換える**

`CardFrontmatterSchema` の該当 3 フィールドを差し替える:

```ts
import { REVIEW_GATES } from '../review.js';

const ReviewGateSchema = z.enum(REVIEW_GATES);
```

```ts
export const CardFrontmatterSchema = z.object({
  id: CardIdSchema,
  title: z.string().min(1).max(200),
  created: IsoDateTime,
  /** 人が探索の着手を指示した時刻 */
  startedAt: nullableField(IsoDateTime).default(null),
  /** 人が事前に見ないと宣言したゲート */
  skipGates: z.array(ReviewGateSchema).default([]),
  /** openspec の change ディレクトリ名 */
  change: nullableField(ChangeNameSchema).default(null),
  /** Git のブランチ名。MR iid の自動解決に使う */
  branch: nullableField(z.string().min(1).max(200)).default(null),
  /** GitLab MR の iid */
  mr: nullableField(z.number().int().positive()).default(null),
});
```

`UpdateCardMetaInputSchema` を差し替える。`stageOverride` は消える:

```ts
/**
 * frontmatter の部分更新。
 * 明示的に null を送ることで「紐付けを外す」を表現できるため、
 * undefined（未指定＝変更しない）と null を区別する。
 *
 * ステージを直接指定する手段は無い。人の判断は `startedAt` の打刻と
 * 本文のレビューログにだけ現れ、そこから導出される。
 */
export const UpdateCardMetaInputSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    startedAt: z.union([IsoDateTime, z.null()]).optional(),
    skipGates: z.array(ReviewGateSchema).optional(),
    change: z.union([ChangeNameSchema, z.null()]).optional(),
    branch: z.union([z.string().min(1).max(200), z.null()]).optional(),
    mr: z.union([z.number().int().positive(), z.null()]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '更新するフィールドを 1 つ以上指定してください',
  });
```

`StageSchema` の import が未使用になるので消す。

さらにレビュー追記の入力スキーマを足す:

```ts
import { REVIEW_GATES, REVIEW_KINDS } from '../review.js';

/**
 * レビューエントリの追記。
 *
 * 提出 / 再提出 は AI が書くもので、この API からは受け付けない。
 * 否決には理由文を必須にする。空の否決は AI が次の周回で読むものを持たないため。
 */
export const AppendReviewInputSchema = z
  .object({
    gate: z.enum(REVIEW_GATES),
    kind: z.enum(REVIEW_KINDS),
    reason: z.string().max(10_000).default(''),
  })
  .refine((value) => value.kind !== '否決' || value.reason.trim() !== '', {
    message: '否決には理由を書いてください',
    path: ['reason'],
  });

export type AppendReviewInput = z.infer<typeof AppendReviewInputSchema>;
```

- [ ] **Step 5: `fs-card.repository.ts` と `create-card.command.ts` を追従させる**

`fs-card.repository.ts` の `serializeCard` と、frontmatter から `Card` を組む箇所のフィールドを差し替える。`serializeCard` はファイル末尾付近にある。既存の並び（id / title / created / … ）を保ち、`explored` / `implStartedAt` の位置に `startedAt` / `skipGates` を置く。

`create-card.command.ts` で新規カードを組んでいる箇所を差し替える:

```ts
const card: Card = {
  id,
  title,
  created: createdAt.toISOString(),
  startedAt: null,
  skipGates: [],
  change: null,
  branch: null,
  mr: null,
  body: body ?? DEFAULT_BODY,
};
```

Run: `npx vitest run src/cards/`
Expected: PASS。`npm run typecheck` は `src/board/` と `src/web/` の型エラーで落ちるが、このタスクでは想定内。

- [ ] **Step 6: コミット（typecheck は次タスクで通す）**

```bash
npx vitest run src/cards/
git add src/cards/
git commit -m "$(cat <<'MSG'
feat!: カードの frontmatter を startedAt / skipGates へ入れ替える

explored / implStartedAt / stageOverride を削除する。
ステージ導出の差し替えは後続のコミットで行うため、
このコミット単体では typecheck が通らない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: ステージ導出の全面差し替え

**Files:**
- Modify: `src/shared/schemas/common.ts`
- Modify: `src/board/services/stage-resolver.ts`
- Test: `src/board/services/__tests__/stage-resolver.test.ts`

**Interfaces:**
- Consumes: Task 1 の `parseReviewLog` / `gateState` / `isAborted` / `hasExploreNote`、Task 3 の `Card`
- Produces:
  - `STAGES = ['idea','exploring','explore-review','planning','plan-review','impling','verifying','pr','merged']`
  - `HUMAN_STAGES = ['idea','exploring']`
  - `interface StageResolution { readonly stage: Stage; readonly reason: string; readonly aborted: boolean; readonly gates: Readonly<Record<ReviewGate, GateState>> }`
  - `resolveStage(card, openspec, mr): StageResolution`
  - `resolveFloorStage(card, openspec, mr): Stage`
  - `droppableStages(floor: Stage): Stage[]`
  - `hasFixAfterReview(mr: MrState): boolean`（export に変更）

- [ ] **Step 1: `STAGES` を入れ替える**

`src/shared/schemas/common.ts`:

```ts
/**
 * カードが取りうる 9 つのステージ。
 * 配列の順序がそのまま「進行度」を表し、UI の列順にも使う。
 *
 * `explore-review` / `plan-review` / `pr` は人の判断を待つ HIL ゲート、
 * それ以外は AI が自走する列（`idea` を除く）。
 */
export const STAGES = [
  'idea',
  'exploring',
  'explore-review',
  'planning',
  'plan-review',
  'impling',
  'verifying',
  'pr',
  'merged',
] as const;
```

- [ ] **Step 2: テストを新しい 9 段へ書き換える（失敗する状態にする）**

`src/board/services/__tests__/stage-resolver.test.ts` の `makeCard` を差し替える:

```ts
function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'refresh-token' as CardId,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    change: 'refresh-token' as ChangeName,
    branch: null,
    mr: null,
    body: '',
    ...overrides,
  };
}
```

本文を組み立てるヘルパを足す:

```ts
/** 探索メモとレビューログを持つ本文を組み立てる */
function makeBody(options: {
  exploreNote?: boolean;
  entries?: ReadonlyArray<{ at: string; gate: 'explore' | 'plan'; kind: string }>;
}): string {
  const parts: string[] = ['## アイデア', '', 'なにかする。', ''];

  if (options.exploreNote === true) {
    parts.push('## 探索メモ', '', '- 調べた', '');
  }

  const entries = options.entries ?? [];
  if (entries.length > 0) {
    parts.push('## レビュー', '');
    for (const entry of entries) {
      parts.push(`### ${entry.at} ${entry.gate} ${entry.kind}`, '');
    }
  }

  return parts.join('\n');
}

const T1 = '2026-09-05T00:00:00.000Z';
const T2 = '2026-09-06T00:00:00.000Z';
const T3 = '2026-09-07T00:00:00.000Z';
```

導出のテーブルテストを全面的に置き換える:

```ts
describe('resolveStage — 自動導出', () => {
  const cases: ReadonlyArray<{
    name: string;
    card: Card;
    openspec: OpenSpecChangeState | null;
    mr: MrState | null;
    expected: Stage;
  }> = [
    {
      name: '何も無ければ idea',
      card: makeCard(),
      openspec: null,
      mr: null,
      expected: 'idea',
    },
    {
      name: 'startedAt が打たれていれば exploring',
      card: makeCard({ startedAt: T1 }),
      openspec: null,
      mr: null,
      expected: 'exploring',
    },
    {
      name: '探索メモがあれば explore-review',
      card: makeCard({ startedAt: T1, body: makeBody({ exploreNote: true }) }),
      openspec: null,
      mr: null,
      expected: 'explore-review',
    },
    {
      name: '探索メモがあり explore 提出が記録されていても explore-review',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [{ at: T2, gate: 'explore', kind: '提出' }],
        }),
      }),
      openspec: null,
      mr: null,
      expected: 'explore-review',
    },
    {
      name: 'explore が否決されたら exploring へ戻る',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [
            { at: T2, gate: 'explore', kind: '提出' },
            { at: T3, gate: 'explore', kind: '否決' },
          ],
        }),
      }),
      openspec: null,
      mr: null,
      expected: 'exploring',
    },
    {
      name: 'explore が承認されたら planning',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [{ at: T2, gate: 'explore', kind: '承認' }],
        }),
      }),
      openspec: null,
      mr: null,
      expected: 'planning',
    },
    {
      name: 'skipGates に explore があれば探索メモが無くても planning',
      card: makeCard({ startedAt: T1, skipGates: ['explore'] }),
      openspec: null,
      mr: null,
      expected: 'planning',
    },
    {
      name: 'proposal.md があれば plan-review',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [{ at: T2, gate: 'explore', kind: '承認' }],
        }),
      }),
      openspec: makeOpenSpec({ artifacts: { proposal: true, specs: false, design: false, tasks: false } }),
      mr: null,
      expected: 'plan-review',
    },
    {
      name: 'plan が否決されたら planning へ戻る',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [
            { at: T2, gate: 'explore', kind: '承認' },
            { at: T3, gate: 'plan', kind: '否決' },
          ],
        }),
      }),
      openspec: makeOpenSpec({ artifacts: { proposal: true, specs: false, design: false, tasks: false } }),
      mr: null,
      expected: 'planning',
    },
    {
      name: 'plan が承認され tasks に未完があれば impling',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [
            { at: T2, gate: 'explore', kind: '承認' },
            { at: T3, gate: 'plan', kind: '承認' },
          ],
        }),
      }),
      openspec: makeOpenSpec({
        artifacts: { proposal: true, specs: false, design: false, tasks: true },
        tasks: { completed: 3, total: 10 },
      }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'plan が承認され tasks が全完了なら verifying',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [
            { at: T2, gate: 'explore', kind: '承認' },
            { at: T3, gate: 'plan', kind: '承認' },
          ],
        }),
      }),
      openspec: makeOpenSpec({
        artifacts: { proposal: true, specs: false, design: false, tasks: true },
        tasks: { completed: 10, total: 10 },
      }),
      mr: null,
      expected: 'verifying',
    },
    {
      name: 'tasks が 0 件なら全完了扱いにせず impling',
      card: makeCard({
        startedAt: T1,
        skipGates: ['explore', 'plan'],
      }),
      openspec: makeOpenSpec({ tasks: { completed: 0, total: 0 } }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'MR が opened なら pr',
      card: makeCard({ startedAt: T1 }),
      openspec: null,
      mr: makeMr({ state: 'opened' }),
      expected: 'pr',
    },
    {
      name: 'MR が merged なら merged',
      card: makeCard({ startedAt: T1 }),
      openspec: null,
      mr: makeMr({ state: 'merged' }),
      expected: 'merged',
    },
    {
      name: 'archive にあれば merged',
      card: makeCard({ startedAt: T1 }),
      openspec: makeOpenSpec({ archived: true, archivedAs: '2026-09-01-refresh-token' }),
      mr: null,
      expected: 'merged',
    },
    {
      name: 'proposal.md があり plan のログが無くても plan-review に着地する',
      card: makeCard({ startedAt: T1, skipGates: ['explore'] }),
      openspec: makeOpenSpec({ artifacts: { proposal: true, specs: false, design: false, tasks: false } }),
      mr: null,
      expected: 'plan-review',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveStage(testCase.card, testCase.openspec, testCase.mr).stage).toBe(
        testCase.expected
      );
    });
  }
});

describe('resolveStage — 中止', () => {
  it('最新のエントリが 中止 なら aborted', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({
        exploreNote: true,
        entries: [
          { at: T2, gate: 'explore', kind: '承認' },
          { at: T3, gate: 'plan', kind: '中止' },
        ],
      }),
    });

    expect(resolveStage(card, null, null).aborted).toBe(true);
  });

  it('中止でなければ aborted は false', () => {
    expect(resolveStage(makeCard(), null, null).aborted).toBe(false);
  });
});

describe('resolveStage — ゲートの状態', () => {
  it('gates に explore / plan の状態を載せる', () => {
    const card = makeCard({
      startedAt: T1,
      skipGates: ['plan'],
      body: makeBody({
        exploreNote: true,
        entries: [{ at: T2, gate: 'explore', kind: '否決' }],
      }),
    });

    expect(resolveStage(card, null, null).gates).toEqual({
      explore: 'rejected',
      plan: 'approved',
    });
  });
});

describe('droppableStages / resolveFloorStage', () => {
  it('何も無いカードは idea と exploring の間を動かせる', () => {
    const card = makeCard({ startedAt: T1 });
    const floor = resolveFloorStage(card, null, null);

    expect(floor).toBe('idea');
    expect(droppableStages(floor)).toEqual(['idea', 'exploring']);
  });

  it('探索メモが書かれたら手では動かせない', () => {
    const card = makeCard({ startedAt: T1, body: makeBody({ exploreNote: true }) });
    const floor = resolveFloorStage(card, null, null);

    expect(floor).toBe('explore-review');
    expect(droppableStages(floor)).toEqual([]);
  });

  it('MR があれば手では動かせない', () => {
    const card = makeCard({ startedAt: T1 });
    const floor = resolveFloorStage(card, null, makeMr({ state: 'opened' }));

    expect(floor).toBe('pr');
    expect(droppableStages(floor)).toEqual([]);
  });
});

describe('hasFixAfterReview', () => {
  it('レビューコメントより後にコミットがあれば true', () => {
    expect(hasFixAfterReview(makeMr({ latestNoteAt: T1, latestCommitAt: T2 }))).toBe(true);
  });

  it('コメントのほうが新しければ false', () => {
    expect(hasFixAfterReview(makeMr({ latestNoteAt: T2, latestCommitAt: T1 }))).toBe(false);
  });

  it('コメントが無ければ false', () => {
    expect(hasFixAfterReview(makeMr({ latestNoteAt: null, latestCommitAt: T2 }))).toBe(false);
  });
});
```

import 文を差し替える:

```ts
import {
  HUMAN_STAGES,
  droppableStages,
  hasFixAfterReview,
  resolveFloorStage,
  resolveStage,
} from '../stage-resolver.js';
```

`HUMAN_STAGES` を検証する既存の describe があれば `['idea', 'exploring']` を期待する形に直す。`stageOverride` を扱う describe は丸ごと削除する。

- [ ] **Step 3: テストを走らせて失敗を確認する**

Run: `npx vitest run src/board/services/__tests__/stage-resolver.test.ts`
Expected: FAIL

- [ ] **Step 4: `stage-resolver.ts` を書き換える**

```ts
import { stageRank, type Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { GateState, ReviewGate } from '../../cards/models/review.js';
import {
  gateState,
  hasExploreNote,
  isAborted,
  parseReviewLog,
} from '../../cards/services/review-log.js';
import type { OpenSpecChangeState } from '../models/openspec-state.js';
import type { MrState } from '../models/mr-state.js';

// ============================================================
// ステージ導出 — このプロジェクトの核
// ============================================================

/**
 * 人が直接ドラッグで動かせるステージ。
 *
 * `startedAt` の打刻と取り消しに対応する 1 遷移だけ。
 * 残りは AI の成果物（openspec / GitLab）か、本文のレビューログが立てる。
 * レビューログへの書き込みはドラッグではなくボタンで行う。
 */
export const HUMAN_STAGES = ['idea', 'exploring'] as const satisfies readonly Stage[];

export interface StageResolution {
  /** 表示する列 */
  readonly stage: Stage;
  /** そのステージになった理由。UI のツールチップに出す */
  readonly reason: string;
  /** 最新のレビューエントリが 中止 か。UI は既定でこのカードを畳む */
  readonly aborted: boolean;
  /** 各ゲートの通過状況。UI のボタン表示に使う */
  readonly gates: Readonly<Record<ReviewGate, GateState>>;
}

/**
 * カードのステージを決める純関数。副作用なし。
 *
 * 下記を上から評価し、最初に真になったものを採用する（＝最も進んだステージ）。
 * `stage` はどこにも保存しない。ここが唯一の決定点である。
 *
 * | # | stage          | 条件                                                    |
 * |---|----------------|---------------------------------------------------------|
 * | 1 | merged         | archive に存在、または MR が merged                      |
 * | 2 | pr             | MR が opened                                             |
 * | 3 | verifying      | plan 承認済み かつ tasks が total > 0 で全完了            |
 * | 4 | impling        | plan 承認済み                                            |
 * | 5 | plan-review    | proposal.md が存在し plan ゲートが none / submitted       |
 * | 6 | planning       | explore 承認済み                                         |
 * | 7 | explore-review | 本文に `## 探索メモ` があり explore が none / submitted   |
 * | 8 | exploring      | startedAt が非 null                                      |
 * | 9 | idea           | 既定                                                     |
 *
 * 否決の差し戻しは専用ルールを持たない。`gate = rejected` のとき
 * その工程のレビュー行と承認行が両方外れ、1 つ手前の AI 列へ自然に落ちる。
 */
export function resolveStage(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): StageResolution {
  const facts = toFacts(card, openspec, mr);
  const { stage, reason } = deriveStage(facts);

  return { stage, reason, aborted: facts.aborted, gates: facts.gates };
}

/**
 * カードの `startedAt` を外したときに残るステージ＝AI の成果物と
 * 人のレビュー記録が課す下限。
 *
 * 導出ルールを二重に持たないよう、`startedAt` を落としたカードで
 * 同じ `deriveStage` を呼ぶ。
 */
export function resolveFloorStage(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): Stage {
  return deriveStage(toFacts({ ...card, startedAt: null }, openspec, mr)).stage;
}

/**
 * その下限のもとで、人が手で入れられる列。
 *
 * 下限より前の列へは戻せない（実態が変わらないため着地できない）ので、
 * `rank(列) >= rank(下限)` を満たす人の列だけを返す。
 */
export function droppableStages(floor: Stage): Stage[] {
  return HUMAN_STAGES.filter((stage) => stageRank(stage) >= stageRank(floor));
}

interface Derivation {
  readonly stage: Stage;
  readonly reason: string;
}

/** 判定に必要な事実をまとめたもの */
interface Facts {
  readonly card: Card;
  readonly openspec: OpenSpecChangeState | null;
  readonly mr: MrState | null;
  readonly gates: Readonly<Record<ReviewGate, GateState>>;
  readonly exploreNote: boolean;
  readonly aborted: boolean;
}

function toFacts(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): Facts {
  const entries = parseReviewLog(card.body);

  return {
    card,
    openspec,
    mr,
    gates: {
      explore: gateState(entries, 'explore', card.skipGates),
      plan: gateState(entries, 'plan', card.skipGates),
    },
    exploreNote: hasExploreNote(card.body),
    aborted: isAborted(entries),
  };
}

/**
 * 進んだステージから順に並べたルール。最初に非 null を返したものが採用される。
 *
 * 「上から評価して最初に真になったものが勝つ」という決まりを、
 * 制御構造ではなく配列の順序で表す。
 */
const RULES: ReadonlyArray<(facts: Facts) => Derivation | null> = [
  // 1. merged — archive されたか、MR がマージされたか
  ({ openspec }) =>
    openspec?.archived === true
      ? {
          stage: 'merged',
          reason: `openspec/changes/archive/${openspec.archivedAs ?? openspec.name} に移動済み`,
        }
      : null,

  ({ mr }) =>
    mr?.state === 'merged' ? { stage: 'merged', reason: `MR !${mr.iid} がマージ済み` } : null,

  // 2. pr — MR が出ている。レビュー後の修正 push はバッジで示す
  ({ mr }) =>
    mr?.state === 'opened'
      ? {
          stage: 'pr',
          reason: hasFixAfterReview(mr)
            ? `MR !${mr.iid} にレビュー後の修正コミットあり（再レビュー待ち）`
            : `MR !${mr.iid} がオープン`,
        }
      : null,

  // 3. verifying — タスクを全部倒したが MR はまだ無い＝品質ゲートを回している
  ({ gates, openspec }) =>
    gates.plan === 'approved' && openspec !== null && isTasksComplete(openspec)
      ? {
          stage: 'verifying',
          reason: `tasks が ${openspec.tasks.total} 件すべて完了し、MR はまだ無い`,
        }
      : null,

  // 4. impling
  ({ gates }) =>
    gates.plan === 'approved' ? { stage: 'impling', reason: '計画が承認されている' } : null,

  // 5. plan-review — 成果物があることを正とし、ログの欠落で人待ちを取りこぼさない
  ({ gates, openspec }) =>
    openspec?.artifacts.proposal === true && (gates.plan === 'none' || gates.plan === 'submitted')
      ? {
          stage: 'plan-review',
          reason: `openspec/changes/${openspec.name}/proposal.md が人の承認を待っている`,
        }
      : null,

  // 6. planning
  ({ gates }) =>
    gates.explore === 'approved' ? { stage: 'planning', reason: '探索が承認されている' } : null,

  // 7. explore-review
  ({ exploreNote, gates }) =>
    exploreNote && (gates.explore === 'none' || gates.explore === 'submitted')
      ? { stage: 'explore-review', reason: '探索メモが人の承認を待っている' }
      : null,

  // 8. exploring
  ({ card }) =>
    card.startedAt !== null
      ? { stage: 'exploring', reason: `${card.startedAt} に着手が指示されている` }
      : null,
];

/** 9. idea — どのルールにも当てはまらなかったとき */
const DEFAULT_DERIVATION: Derivation = {
  stage: 'idea',
  reason: 'まだ着手が指示されていない',
};

function deriveStage(facts: Facts): Derivation {
  for (const rule of RULES) {
    const derivation = rule(facts);
    if (derivation !== null) {
      return derivation;
    }
  }

  return DEFAULT_DERIVATION;
}

/**
 * tasks を全部倒したか。
 *
 * `total === 0` を全完了扱いにしない。tasks.md がまだ無いだけの change を
 * 検証中へ飛ばしてしまうため。
 */
function isTasksComplete(openspec: OpenSpecChangeState): boolean {
  return openspec.tasks.total > 0 && openspec.tasks.completed === openspec.tasks.total;
}

/**
 * 「AI が指摘を受けて修正を push した」か。
 *
 * レビューコメントが 1 件も無い新規 MR では成立しない。
 * 新しいコメントが来れば日時が逆転し、自然に false へ戻る。
 *
 * かつては `ai-pr-fixed` 列を立てていたが、いまは `pr` 列内のバッジに使う。
 */
export function hasFixAfterReview(mr: MrState): boolean {
  if (mr.latestNoteAt === null || mr.latestCommitAt === null) {
    return false;
  }

  const noteMs = Date.parse(mr.latestNoteAt);
  const commitMs = Date.parse(mr.latestCommitAt);

  if (Number.isNaN(noteMs) || Number.isNaN(commitMs)) {
    return false;
  }

  return commitMs > noteMs;
}
```

- [ ] **Step 5: テストを走らせて通ることを確認する**

Run: `npx vitest run src/board/services/__tests__/stage-resolver.test.ts`
Expected: PASS

- [ ] **Step 6: コミット（typecheck は次タスクで通す）**

```bash
npx vitest run src/board/services/
git add src/shared/schemas/common.ts src/board/services/
git commit -m "$(cat <<'MSG'
feat!: ステージ導出を HIL ゲート付きの 9 段へ差し替える

レビューログと skipGates を導出の入力に加え、stageOverride を廃する。
board / web の追従は後続のコミットで行う。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: BoardCard とボード取得の追従

**Files:**
- Modify: `src/board/models/board-card.ts`
- Modify: `src/board/usecases/queries/get-board.query.ts`
- Test: `src/board/controllers/__tests__/board.e2e.test.ts`

**Interfaces:**
- Consumes: Task 4 の `StageResolution` / `hasFixAfterReview`
- Produces: 新しい `BoardCard`
  ```ts
  interface BoardCard {
    readonly id: string;
    readonly title: string;
    readonly created: string;
    readonly stage: Stage;
    readonly reason: string;
    readonly aborted: boolean;
    readonly gates: Readonly<Record<ReviewGate, GateState>>;
    readonly floorStage: Stage;
    readonly droppableStages: readonly Stage[];
    readonly startedAt: string | null;
    readonly skipGates: readonly ReviewGate[];
    readonly change: string | null;
    readonly branch: string | null;
    readonly mr: number | null;
    readonly body: string;
    readonly openspec: BoardCardOpenSpec | null;
    readonly mrState: BoardCardMr | null;
  }
  ```
  `BoardCardMr` に `readonly resubmitted: boolean` が増える。

- [ ] **Step 1: `board-card.ts` を書き換える**

`BoardCardMr` に 1 行足す:

```ts
export interface BoardCardMr {
  readonly iid: number;
  readonly state: MrLifecycleState;
  readonly title: string;
  readonly webUrl: string;
  readonly noteCount: number;
  readonly latestNoteAt: string | null;
  readonly latestCommitAt: string | null;
  /** レビュー指摘のあとに修正コミットが push されたか＝再レビュー待ち */
  readonly resubmitted: boolean;
}
```

`BoardCard` から `derivedStage` / `overridden` / `diverged` / `stageOverride` / `explored` / `implStartedAt` を削り、`reason` の隣に `aborted` / `gates` を、`floorStage` の隣に `startedAt` / `skipGates` を置く。

`toBoardCard` のシグネチャを差し替える:

```ts
/** Card と導出結果から BoardCard を組み立てる */
export function toBoardCard(
  card: Card,
  resolution: StageResolution,
  movement: {
    floorStage: Stage;
    droppableStages: readonly Stage[];
  },
  openspec: BoardCardOpenSpec | null,
  mrState: BoardCardMr | null
): BoardCard {
  return {
    id: card.id,
    title: card.title,
    created: card.created,
    stage: resolution.stage,
    reason: resolution.reason,
    aborted: resolution.aborted,
    gates: resolution.gates,
    floorStage: movement.floorStage,
    droppableStages: movement.droppableStages,
    startedAt: card.startedAt,
    skipGates: card.skipGates,
    change: card.change,
    branch: card.branch,
    mr: card.mr,
    body: card.body,
    openspec,
    mrState,
  };
}
```

import に `import type { StageResolution } from '../services/stage-resolver.js';` を足す。

- [ ] **Step 2: `get-board.query.ts` を追従させる**

`toBoardCardMr` に `resubmitted` を足す:

```ts
function toBoardCardMr(mr: MrState | null): BoardCardMr | null {
  if (mr === null) return null;

  return {
    iid: mr.iid,
    state: mr.state,
    title: mr.title,
    webUrl: mr.webUrl,
    noteCount: mr.noteCount,
    latestNoteAt: mr.latestNoteAt,
    latestCommitAt: mr.latestCommitAt,
    resubmitted: hasFixAfterReview(mr),
  };
}
```

import に `hasFixAfterReview` を足す。`toBoardCard` の呼び出しは引数の形が変わらないためそのままで通る。

- [ ] **Step 3: e2e テストを追従させ、9 列の往復を検証する**

`src/board/controllers/__tests__/board.e2e.test.ts` の中で、カードファイルを書いているフィクスチャの frontmatter を新スキーマへ書き換える（`explored:` / `implStartedAt:` / `stageOverride:` を `startedAt:` / `skipGates:` へ）。そのうえで次を足す:

このファイルのヘルパは `writeFile(relativePath, content)` と `buildApp(mrProvider?)`（どちらもファイル冒頭で定義済み）。カードは `.ai-board/cards/<id>.md` への `writeFile` で作る。新しい describe を足す:

```ts
describe('GET /api/board — レビューログからの導出', () => {
  const app = buildApp();

  const GATED_CARD = [
    '---',
    'id: gated',
    'title: ゲート付きのカード',
    'created: 2026-09-01T00:00:00.000Z',
    'startedAt: 2026-09-05T00:00:00.000Z',
    'skipGates: []',
    '---',
    '',
    '## アイデア',
    '',
    'なにかする。',
    '',
    '## 探索メモ',
    '',
    '- 調べた',
    '',
    '## レビュー',
    '',
    '### 2026-09-06T00:00:00.000Z explore 承認',
    '',
  ].join('\n');

  it('探索が承認されていれば planning', async () => {
    await writeFile('.ai-board/cards/gated.md', GATED_CARD);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('planning');
    expect(card.gates).toEqual({ explore: 'approved', plan: 'none' });
    expect(card.aborted).toBe(false);
    expect(card.droppableStages).toEqual([]);
  });

  it('BoardCard に stageOverride 関連のフィールドは現れない', async () => {
    await writeFile('.ai-board/cards/gated.md', GATED_CARD);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card).not.toHaveProperty('stageOverride');
    expect(card).not.toHaveProperty('diverged');
    expect(card).not.toHaveProperty('overridden');
    expect(card).not.toHaveProperty('derivedStage');
  });

  it('PATCH で stageOverride を送っても無視される', async () => {
    await writeFile('.ai-board/cards/gated.md', GATED_CARD);

    await request(app)
      .patch('/api/cards/gated')
      .send({ stageOverride: 'merged', title: '別のタイトル' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.title).toBe('別のタイトル');
    expect(card.stage).toBe('planning');
  });
});
```

既存の `stageOverride` を扱う e2e ケース（`PATCH` で 400 を期待するもの、および乖離バッジを検証するもの）は削除する。

- [ ] **Step 4: 品質ゲートを通す**

Run: `npm run typecheck`
Expected: サーバ側は PASS。`src/web/` 側は Task 7 まで落ちる。

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/board/
git commit -m "$(cat <<'MSG'
feat!: BoardCard を 9 段のステージとゲート状態へ差し替える

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: 承認 / 否決 / 中止の API

**Files:**
- Create: `src/cards/usecases/commands/append-review.command.ts`
- Modify: `src/cards/composition.ts`
- Modify: `src/cards/controllers/card.controller.ts`
- Test: `src/cards/usecases/__tests__/card-commands.test.ts`
- Test: `src/board/controllers/__tests__/board.e2e.test.ts`

**Interfaces:**
- Consumes: Task 2 の `appendReviewEntry`、Task 3 の `AppendReviewInputSchema`
- Produces:
  ```ts
  interface AppendReviewCommandInput {
    readonly id: CardId;
    readonly gate: ReviewGate;
    readonly kind: ReviewKind;
    readonly reason: string;
    readonly at: Date;
  }
  type AppendReviewCommand = (input: AppendReviewCommandInput) => Promise<Result<Card, UpdateCardError>>;
  function createAppendReviewCommand(cardRepository: CardRepository): AppendReviewCommand;
  ```
  HTTP: `POST /api/cards/:id/reviews`

- [ ] **Step 1: 失敗するテストを書く**

`src/cards/usecases/__tests__/card-commands.test.ts` の末尾に追加:

```ts
describe('appendReviewCommand', () => {
  it('本文の ## レビュー にエントリを足す', async () => {
    const repository = new FsCardRepository(cardsDir);
    const command = createAppendReviewCommand(repository);

    await repository.create({
      id: 'reviewed' as CardId,
      title: 'レビュー対象',
      created: '2026-09-01T00:00:00.000Z',
      startedAt: '2026-09-05T00:00:00.000Z',
      skipGates: [],
      change: null,
      branch: null,
      mr: null,
      body: '## アイデア\n\nなにかする。\n',
    });

    const result = await command({
      id: 'reviewed' as CardId,
      gate: 'explore',
      kind: '否決',
      reason: 'まだ浅い',
      at: new Date('2026-09-06T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);

    const saved = await repository.findById('reviewed' as CardId);
    expect(saved?.body).toContain('### 2026-09-06T00:00:00.000Z explore 否決');
    expect(saved?.body).toContain('まだ浅い');
  });

  it('存在しないカードなら CardNotFound', async () => {
    const command = createAppendReviewCommand(new FsCardRepository(cardsDir));

    const result = await command({
      id: 'missing' as CardId,
      gate: 'plan',
      kind: '承認',
      reason: '',
      at: new Date('2026-09-06T00:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('CardNotFound');
    }
  });
});
```

`src/board/controllers/__tests__/board.e2e.test.ts` の末尾に追加:

```ts
describe('POST /api/cards/:id/reviews', () => {
  const app = buildApp();

  const AWAITING_CARD = [
    '---',
    'id: awaiting',
    'title: レビュー待ちのカード',
    'created: 2026-09-01T00:00:00.000Z',
    'startedAt: 2026-09-05T00:00:00.000Z',
    'skipGates: []',
    '---',
    '',
    '## アイデア',
    '',
    'なにかする。',
    '',
    '## 探索メモ',
    '',
    '- 調べた',
    '',
  ].join('\n');

  it('承認を追記するとステージが進む', async () => {
    await writeFile('.ai-board/cards/awaiting.md', AWAITING_CARD);

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'explore', kind: '承認' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);

    expect(response.body.cards[0].stage).toBe('planning');
  });

  it('否決を追記すると探索中へ戻り、理由が本文に残る', async () => {
    await writeFile('.ai-board/cards/awaiting.md', AWAITING_CARD);

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'explore', kind: '否決', reason: 'まだ浅い' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('exploring');
    expect(card.body).toContain('まだ浅い');
  });

  it('理由の無い否決は 400', async () => {
    await writeFile('.ai-board/cards/awaiting.md', AWAITING_CARD);

    const response = await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'explore', kind: '否決' })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.message).toContain('否決には理由を書いてください');
  });

  it('中止を追記すると aborted になる', async () => {
    await writeFile('.ai-board/cards/awaiting.md', AWAITING_CARD);

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'explore', kind: '中止', reason: 'やめる' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);

    expect(response.body.cards[0].aborted).toBe(true);
  });

  it('存在しないカードなら 404', async () => {
    await request(app)
      .post('/api/cards/nope/reviews')
      .send({ gate: 'plan', kind: '承認' })
      .expect(404);
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認する**

Run: `npx vitest run -t appendReviewCommand`
Expected: FAIL（`createAppendReviewCommand` が無い）

- [ ] **Step 3: ユースケースを書く**

`src/cards/usecases/commands/append-review.command.ts`:

```ts
import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { ReviewGate, ReviewKind } from '../../models/review.js';
import { appendReviewEntry } from '../../services/review-log.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { UpdateCardError } from '../../errors/card-errors.js';

// ============================================================
// レビュー追記ユースケース
// ============================================================

export interface AppendReviewCommandInput {
  readonly id: CardId;
  readonly gate: ReviewGate;
  readonly kind: ReviewKind;
  readonly reason: string;
  readonly at: Date;
}

export type AppendReviewCommand = (
  input: AppendReviewCommandInput
) => Promise<Result<Card, UpdateCardError>>;

/**
 * 人の判断をカード本文へ追記する。
 *
 * ステージは書かない。追記されたログを `resolveStage` が読み、
 * 次の `GET /api/board` で列が変わる。
 */
export function createAppendReviewCommand(cardRepository: CardRepository): AppendReviewCommand {
  return async ({ id, gate, kind, reason, at }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    const updated: Card = {
      ...existing,
      body: appendReviewEntry(existing.body, {
        at: at.toISOString(),
        gate,
        kind,
        reason: reason.trim(),
      }),
    };

    const saved = await cardRepository.save(updated);
    if (!saved) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}
```

- [ ] **Step 4: composition root に足す**

`src/cards/composition.ts` の `CardDependencies` に `appendReviewCommand: AppendReviewCommand` を足し、既存の command と同じ形で `createAppendReviewCommand(cardRepository)` を組む。

- [ ] **Step 5: ルートを足す**

`src/cards/controllers/card.controller.ts`:

`toCardResponse` を新スキーマへ差し替える:

```ts
function toCardResponse(card: Card): Record<string, unknown> {
  return {
    id: card.id,
    title: card.title,
    created: card.created,
    startedAt: card.startedAt,
    skipGates: card.skipGates,
    change: card.change,
    branch: card.branch,
    mr: card.mr,
    body: card.body,
  };
}
```

`createCardRouter` の分割代入に `appendReviewCommand` を足し、`PUT /:id/body` の後ろにルートを足す:

```ts
/** POST /api/cards/:id/reviews — レビューエントリの追記 */
router.post('/:id/reviews', async (req: Request, res: Response): Promise<void> => {
  const id = parseCardId(req, res);
  if (id === null) return;

  const input = AppendReviewInputSchema.safeParse(req.body);
  if (!input.success) {
    respondValidationError(res, input.error);
    return;
  }

  const result = await appendReviewCommand({
    id,
    gate: input.data.gate,
    kind: input.data.kind,
    reason: input.data.reason,
    at: new Date(),
  });

  if (!result.ok) {
    const { status, response } = mapUpdateCardErrorToResponse(result.error);
    res.status(status).json(response);
    return;
  }

  res.json(toCardResponse(result.value));
});
```

import に `AppendReviewInputSchema` を足す。

`UpdateCardError` は `CardNotFound` のみなので `card-error-mappings.ts` の `switch` に変更は要らない。理由の欠落は Zod が 400 で弾く。

- [ ] **Step 6: テストを走らせて通ることを確認する**

Run: `npm run typecheck && npx vitest run`
Expected: サーバ側の typecheck は PASS、テストは PASS。web の typecheck は Task 7 まで落ちる。

- [ ] **Step 7: コミット**

```bash
git add src/cards/
git commit -m "$(cat <<'MSG'
feat: 承認 / 否決 / 中止を追記する POST /api/cards/:id/reviews を足す

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: web の型と 9 列

**Files:**
- Modify: `src/web/types.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/components/Board.tsx`
- Modify: `src/web/components/Column.tsx`

**Interfaces:**
- Consumes: Task 5 の `BoardCard`、Task 6 の `POST /api/cards/:id/reviews`
- Produces:
  - `type Stage`（9 値）、`STAGE_LABELS`、`STAGE_SOURCE`、`STAGE_OWNER`
  - `appendReview(id: string, input: { gate: ReviewGate; kind: ReviewKind; reason?: string }): Promise<BoardCard>`

`src/web/` は vitest の対象外。このタスクの検証は `npm run typecheck` と `npm run lint`、および `npm run dev` + `npm run dev:web` での目視。

- [ ] **Step 1: `types.ts` を書き換える**

```ts
export type Stage =
  | 'idea'
  | 'exploring'
  | 'explore-review'
  | 'planning'
  | 'plan-review'
  | 'impling'
  | 'verifying'
  | 'pr'
  | 'merged';

export type ReviewGate = 'explore' | 'plan';

export type ReviewKind = '提出' | '再提出' | '承認' | '否決' | '中止';

export type GateState = 'none' | 'submitted' | 'approved' | 'rejected';
```

`BoardCard` を Task 5 の形に合わせる（`derivedStage` / `overridden` / `diverged` / `stageOverride` / `explored` / `implStartedAt` を削り、`aborted` / `gates` / `startedAt` / `skipGates` を足す）。`BoardCardMr` に `resubmitted: boolean` を足す。

ラベルと所有者:

```ts
/**
 * 人が直接ドラッグで動かせるステージ。
 * 残りは AI の成果物か、レビューボタンの追記で決まる。
 */
export const HUMAN_STAGES: Stage[] = ['idea', 'exploring'];

export function isHumanStage(stage: Stage): boolean {
  return HUMAN_STAGES.includes(stage);
}

/** 列見出しに出す日本語ラベル */
export const STAGE_LABELS: Record<Stage, string> = {
  idea: 'アイデア',
  exploring: '探索中',
  'explore-review': '探索レビュー',
  planning: '計画提案中',
  'plan-review': '計画レビュー',
  impling: '実装中',
  verifying: '検証中',
  pr: 'PR中',
  merged: 'マージ済み',
};

/** その列で次に動くのは誰か。見出しのアイコンに使う */
export const STAGE_OWNER: Record<Stage, 'human' | 'ai' | 'none'> = {
  idea: 'human',
  exploring: 'ai',
  'explore-review': 'human',
  planning: 'ai',
  'plan-review': 'human',
  impling: 'ai',
  verifying: 'ai',
  pr: 'human',
  merged: 'none',
};

/** 列の帯色 = そのステージを立てる情報源 */
export const STAGE_SOURCE: Record<Stage, 'card' | 'openspec' | 'gitlab' | 'archive'> = {
  idea: 'card',
  exploring: 'card',
  'explore-review': 'card',
  planning: 'card',
  'plan-review': 'openspec',
  impling: 'openspec',
  verifying: 'openspec',
  pr: 'gitlab',
  merged: 'archive',
};

/** ゲートが人の判断を待っている列 */
export const GATE_OF_STAGE: Partial<Record<Stage, ReviewGate>> = {
  'explore-review': 'explore',
  'plan-review': 'plan',
};
```

- [ ] **Step 2: `api.ts` を書き換える**

`CardMetaPatch` を差し替える:

```ts
export interface CardMetaPatch {
  title?: string;
  startedAt?: string | null;
  skipGates?: ReviewGate[];
  change?: string | null;
  branch?: string | null;
  mr?: number | null;
}
```

`appendReview` を足す:

```ts
export function appendReview(
  id: string,
  input: { gate: ReviewGate; kind: ReviewKind; reason?: string }
): Promise<BoardCard> {
  return request<BoardCard>(`/api/cards/${encodeURIComponent(id)}/reviews`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
```

import 文に `ReviewGate` / `ReviewKind` を足し、未使用になった `Stage` を消す。

- [ ] **Step 3: `Board.tsx` を書き換える**

```ts
/**
 * ドロップ先の列に応じて書き込むフラグ。
 *
 * 人がドラッグで動かせるのは着手の 1 遷移だけ。
 * 承認 / 否決 / 中止はドラッグではなく詳細パネルのボタンで行う。
 */
function patchForStage(stage: Stage): CardMetaPatch | null {
  switch (stage) {
    case 'idea':
      return { startedAt: null };
    case 'exploring':
      return { startedAt: new Date().toISOString() };
    default:
      // AI の成果物かレビューログから導出される列。ドラッグでは着地できない
      return null;
  }
}
```

`handleDrop` から `stageOverride` を外す処理（`withOverrideCleared`）を削除し、`updateCardMeta(card.id, patch)` を直接呼ぶ。

見出しコメントを `// 9 列のカンバン` に直す。

- [ ] **Step 4: `Column.tsx` を書き換える**

`isHumanStage` による 🔒 の出し分けを `STAGE_OWNER` ベースに変える:

```tsx
import { STAGE_LABELS, STAGE_OWNER, STAGE_SOURCE, type BoardCard, type Stage } from '../types.js';
```

```tsx
const OWNER_MARK: Record<'human' | 'ai' | 'none', { icon: string; title: string } | null> = {
  human: { icon: '★', title: 'あなたの判断を待っています' },
  ai: { icon: '🤖', title: 'AI が進めます。手では動かせません' },
  none: null,
};
```

```tsx
<span className="name">
  {STAGE_LABELS[stage]}
  {OWNER_MARK[STAGE_OWNER[stage]] !== null && (
    <span className="owner" title={OWNER_MARK[STAGE_OWNER[stage]]?.title}>
      {OWNER_MARK[STAGE_OWNER[stage]]?.icon}
    </span>
  )}
</span>
```

`styles.css` の `.lock` セレクタを `.owner` へ改名する（同じ見た目でよい）。

- [ ] **Step 5: 型と lint を通す**

Run: `npm run typecheck`
Expected: `CardDetail.tsx` / `ProgressActions.tsx` / `StageSection.tsx` / `CardBadges.tsx` / `App.tsx` が落ちる（Task 8 で直す）

- [ ] **Step 6: コミット（Task 8 と合わせて typecheck を通す）**

このタスクはコミットせず、Task 8 まで進めてから 1 コミットにまとめる。

---

### Task 8: web のレビュー UI

**Files:**
- Create: `src/web/components/detail/ReviewActions.tsx`
- Delete: `src/web/components/detail/ProgressActions.tsx`
- Modify: `src/web/components/CardDetail.tsx`
- Modify: `src/web/components/detail/StageSection.tsx`
- Modify: `src/web/components/CardBadges.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: Task 7 の `appendReview` / `GATE_OF_STAGE` / `STAGE_LABELS`

- [ ] **Step 1: `ReviewActions.tsx` を書く**

```tsx
import { useState } from 'react';
import { appendReview } from '../../api.js';
import { GATE_OF_STAGE, STAGE_LABELS, type BoardCard } from '../../types.js';

// ============================================================
// 承認 / 否決 / 中止
// ============================================================

interface ReviewActionsProps {
  card: BoardCard;
  saving: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}

/**
 * 人の判断をカード本文の `## レビュー` へ追記する。
 *
 * ステージは書かない。追記されたログをサーバが読み直し、
 * 次のボード取得で列が変わる。
 */
export function ReviewActions({ card, saving, onRun }: ReviewActionsProps) {
  const [reason, setReason] = useState('');

  const gate = GATE_OF_STAGE[card.stage];

  if (gate === undefined) {
    return (
      <>
        <h3>レビュー</h3>
        <p className="movable">
          {STAGE_LABELS[card.stage]} は判断を待つ列ではありません。
        </p>
      </>
    );
  }

  const submit = (kind: '承認' | '否決' | '中止'): void => {
    void onRun(async () => {
      await appendReview(card.id, { gate, kind, reason });
      setReason('');
    });
  };

  return (
    <>
      <h3>レビュー</h3>

      <textarea
        className="reason-input"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        spellCheck={false}
        placeholder="否決の理由（AI が次の周回で読みます）"
      />

      <div className="actions">
        <button type="button" className="btn" disabled={saving} onClick={() => submit('承認')}>
          承認
        </button>

        <button
          type="button"
          className="btn ghost"
          disabled={saving || reason.trim() === ''}
          title={reason.trim() === '' ? '否決には理由が必要です' : undefined}
          onClick={() => submit('否決')}
        >
          否決して差し戻す
        </button>

        <button type="button" className="btn ghost" disabled={saving} onClick={() => submit('中止')}>
          中止する
        </button>
      </div>
    </>
  );
}
```

- [ ] **Step 2: `ProgressActions.tsx` を消して `CardDetail.tsx` を差し替える**

```bash
git rm src/web/components/detail/ProgressActions.tsx
```

`CardDetail.tsx` の import と JSX を差し替える:

```tsx
import { ReviewActions } from './detail/ReviewActions.js';
```

```tsx
<StageSection card={card} />
<ReviewActions card={card} saving={saving} onRun={run} />
<LinkFields card={card} saving={saving} onPatch={patch} />
<BodyEditor card={card} saving={saving} onRun={run} />
```

`StageSection` は `saving` / `onPatch` を取らなくなる（上書き解除ボタンが消えるため）。

- [ ] **Step 3: `StageSection.tsx` から上書き関連を削る**

```tsx
import { STAGE_LABELS, STAGE_OWNER, type BoardCard } from '../../types.js';

// ============================================================
// ステージの表示
// ============================================================

/**
 * ステージは選ぶものではなく、実態から決まるもの。
 * ここでは「今どこにいて、なぜそこにいて、どこまで動かせるか」を示す。
 */
export function StageSection({ card }: { card: BoardCard }) {
  const owner = STAGE_OWNER[card.stage];

  return (
    <>
      <h3>ステージ</h3>

      <p className="stage-now">
        <span className={`stage-chip${owner === 'ai' ? ' ai' : ''}`}>
          {STAGE_LABELS[card.stage]}
        </span>
        {owner === 'ai' && <span className="stage-owner">AI の領分</span>}
        {owner === 'human' && <span className="stage-owner">あなたの判断待ち</span>}
      </p>

      <div className="reason">{card.reason}</div>

      <p className="movable">{describeMovement(card)}</p>

      {card.aborted && <div className="divergence">このカードは中止されています。</div>}
    </>
  );
}

/** どこまで手で動かせるかを一文で説明する */
function describeMovement(card: BoardCard): string {
  if (card.droppableStages.length === 0) {
    return `${STAGE_LABELS[card.floorStage]} まで進んでいるため、手では動かせません。`;
  }

  const labels = card.droppableStages.map((stage) => STAGE_LABELS[stage]).join(' / ');

  return `手で動かせる先: ${labels}`;
}
```

- [ ] **Step 4: `CardBadges.tsx` を差し替える**

`card.stage === 'impling'` のバッジと `card.diverged` のバッジを消し、再提出と中止とスキップのバッジを足す:

```tsx
{card.mrState?.resubmitted === true && <span className="badge gitlab">再提出済み</span>}

{card.skipGates.length > 0 && (
  <span className="badge manual" title="人のレビューを飛ばす設定です">
    skip: {card.skipGates.join(' / ')}
  </span>
)}

{card.aborted && <span className="badge warn">中止</span>}

{card.stage === 'idea' && card.change === null && (
  <span className="badge manual">card only</span>
)}
```

`STAGE_LABELS` の import が未使用になれば消す。

- [ ] **Step 5: `App.tsx` で中止カードを畳む**

ボードを `Board` に渡す前に、中止カードを除いたビューを作る。トグルを 1 つ足す:

```tsx
const [showAborted, setShowAborted] = useState(false);

const visible = useMemo(
  () =>
    board === null
      ? null
      : { ...board, cards: showAborted ? board.cards : board.cards.filter((card) => !card.aborted) },
  [board, showAborted]
);

const abortedCount = board?.cards.filter((card) => card.aborted).length ?? 0;
```

トップバーに置くトグル:

```tsx
{abortedCount > 0 && (
  <button type="button" className="btn ghost" onClick={() => setShowAborted((on) => !on)}>
    {showAborted ? `中止 ${abortedCount} 件を隠す` : `中止 ${abortedCount} 件を表示`}
  </button>
)}
```

`Board` へは `visible` を渡す。既存の `board` を参照している箇所（GitLab 接続状態、`orphanChanges`）はそのままでよい。

- [ ] **Step 6: `styles.css` を追従させる**

- `.lock` を `.owner` へ改名
- `.reason-input` を足す（`textarea` の既存スタイルを流用し、`min-height: 4rem` 程度）
- `.board` のグリッド定義が列数に依存していれば 9 列で収まるよう `min-width` を見直す

- [ ] **Step 7: 品質ゲートを通す**

Run: `npm run typecheck && npm run lint && npm test`
Expected: すべて PASS

- [ ] **Step 8: 目視で確認する**

```bash
npm run dev &
npm run dev:web
```

ブラウザで確認すること:
- 9 列が並び、`探索レビュー` / `計画レビュー` / `PR中` に ★ が出る
- アイデア列のカードを探索中へドラッグでき、逆も戻せる
- 探索メモを本文に書いて保存すると探索レビュー列へ移り、掴めなくなる
- 探索レビュー列のカードで「否決して差し戻す」を押すと探索中へ戻り、本文に理由が残る
- 「中止する」を押すとカードが消え、トップバーのトグルで戻せる

- [ ] **Step 9: コミット**

```bash
git add -A src/web/
git commit -m "$(cat <<'MSG'
feat!: ボード UI を 9 列とレビューボタンへ作り直す

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: 既存カードの移行とドキュメント

**Files:**
- Modify: `.ai-board/cards/*.md`（16 枚）
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `.ai-board/cards/board-loop-skill.md`

**Interfaces:**
- Consumes: Task 3 の新スキーマ

- [ ] **Step 1: 既存カードの frontmatter を移行する**

全カードが `explored: false` / `implStartedAt: null` なので、機械的な置換で足りる。

```bash
cd /Users/eiji/src/ai-board
for f in .ai-board/cards/*.md; do
  perl -0pi -e 's/^explored: false\nimplStartedAt: null\n/startedAt: null\nskipGates: []\n/m' "$f"
  perl -0pi -e 's/^stageOverride: null\n//m' "$f"
done
grep -l 'explored\|implStartedAt\|stageOverride' .ai-board/cards/*.md || echo '移行完了'
```

`explored: true` や `implStartedAt` が非 null のカードが残っていた場合は手で直す。規則は spec の「移行」節に従う。

Run: `npx vitest run && npm run dev` でボードを開き、`agents-md` が `pr` か `merged` に、残りが `idea` に並ぶことを確認する。

- [ ] **Step 2: `board-loop-skill.md` のハードルールを書き換える**

`## アイデア` の末尾のハードルール節を差し替える:

```markdown
**ハードルール**（人の承認を代行しない）

- `startedAt` を自分で打たない。着手の指示は人が出す
- `## レビュー` に書いてよいのは 提出 / 再提出 だけ。承認 / 否決 / 中止は人が書く
- `skipGates` を自分で足さない
- 品質ゲートを通らないままコミットしない
```

1 周で行うことの一覧も 9 列に合わせて書き直す:

```markdown
1. 計画レビューを通ったカードがあれば → 実装を 1 ステップ進めてコミット
2. 探索レビューを通ったカードがあれば → openspec change を起票し `## レビュー` に plan 提出を書く
3. 探索中のカードがあれば → 調べて `## 探索メモ` を書き、`## レビュー` に explore 提出を書く
4. どれも無ければ → 人待ちを報告して終わる
```

- [ ] **Step 3: `CLAUDE.md` を書き換える**

差し替える節:

- 冒頭の 7 段の矢印図 → 9 列の図
- 「タスクは `.ai-board/cards/` にある」の frontmatter サンプル → 新スキーマ
- 「書き込み境界」の表 → AI が書ける先に「カード本文の `## 探索メモ` と `## レビュー`（提出 / 再提出 のみ）」を明記
- 「ステージ導出」の節 → 9 段の表と、`stageOverride` に関する記述の削除、`resolveFloorStage` / `droppableStages` が 1 遷移に縮んだこと
- 「API」の表 → `POST /api/cards/:id/reviews` を追加

- [ ] **Step 4: `README.md` の判定表を差し替える**

`stage-resolver.ts` の docstring にある 9 段の表をそのまま反映する。

- [ ] **Step 5: 品質ゲートを通してコミット**

```bash
npm run typecheck && npm run lint && npm test
git add -A
git commit -m "$(cat <<'MSG'
docs: 9 列のレーンに合わせて規約とカードを移行する

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

- [ ] **Step 6: カードにブランチとレビュー記録を書く**

`.ai-board/cards/board-lanes.md` の本文に、この計画の完了を示す `## レビュー` の plan 提出エントリを足す。

```bash
git add .ai-board/cards/board-lanes.md
git commit -m "$(cat <<'MSG'
chore: board-lanes カードに plan 提出を記録する

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```
