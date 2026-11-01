import { describe, it, expect, beforeEach } from 'vitest';
import { createCreateCardCommand } from '../commands/create-card.command.js';
import { createUpdateCardMetaCommand } from '../commands/update-card-meta.command.js';
import { createUpdateCardBodyCommand } from '../commands/update-card-body.command.js';
import { createAppendReviewCommand } from '../commands/append-review.command.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { Card } from '../../models/card.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { ReviewEntry } from '../../models/review.js';
import { appendReviewEntry, parseReviewLog } from '../../services/review-log.js';
import { demoteHeadings } from '../../repositories/card-files.js';

// ============================================================
// インメモリのテストダブル
// ============================================================

class InMemoryCardRepository implements CardRepository {
  readonly cards = new Map<string, Card>();

  async findAll(): Promise<Card[]> {
    return [...this.cards.values()];
  }

  async findById(id: CardId): Promise<Card | null> {
    return this.cards.get(id) ?? null;
  }

  async create(card: Card): Promise<boolean> {
    if (this.cards.has(card.id)) return false;
    this.cards.set(card.id, card);
    return true;
  }

  async save(card: Card): Promise<boolean> {
    if (!this.cards.has(card.id)) return false;
    this.cards.set(card.id, card);
    return true;
  }

  /** ファイルのリポジトリと同じく、理由の中の見出しを下げた判断を本文の `## レビュー` に足す */
  async appendReview(id: CardId, entry: ReviewEntry): Promise<boolean> {
    const card = this.cards.get(id);
    if (card === undefined) return false;
    const reason = demoteHeadings(entry.reason.trim());
    this.cards.set(id, { ...card, body: appendReviewEntry(card.body, { ...entry, reason }) });
    return true;
  }
}

let repository: InMemoryCardRepository;

beforeEach(() => {
  repository = new InMemoryCardRepository();
});

const createdAt = new Date('2026-09-04T10:00:00.000Z');

// ============================================================
// 作成
// ============================================================

describe('createCardCommand', () => {
  it('タイトルから ID を生成する', async () => {
    const result = await createCreateCardCommand(repository)({
      title: 'Refresh Token Support',
      createdAt,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('refresh-token-support');
      expect(result.value.created).toBe('2026-09-04T10:00:00.000Z');
      expect(result.value.startedAt).toBeNull();
    }
  });

  it('ID を明示できる', async () => {
    const result = await createCreateCardCommand(repository)({
      title: 'リフレッシュトークン対応',
      id: 'refresh-token',
      createdAt,
    });

    expect(result.ok && result.value.id).toBe('refresh-token');
  });

  it('日本語だけのタイトルは ID を生成できず InvalidCardId になる', async () => {
    const result = await createCreateCardCommand(repository)({
      title: 'リフレッシュトークン対応',
      createdAt,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('InvalidCardId');
  });

  it('不正な形式の ID を弾く', async () => {
    const result = await createCreateCardCommand(repository)({
      title: 'test',
      id: 'Bad ID!',
      createdAt,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('InvalidCardId');
  });

  it('ID が重複したら DuplicateCardId', async () => {
    const command = createCreateCardCommand(repository);
    await command({ title: 'first', id: 'dup', createdAt });

    const result = await command({ title: 'second', id: 'dup', createdAt });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('DuplicateCardId');
  });

  it('新規カードは idea 相当の初期値を持つ', async () => {
    const result = await createCreateCardCommand(repository)({ title: 'idea', createdAt });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startedAt).toBeNull();
      expect(result.value.skipGates).toEqual([]);
      expect(result.value.mr).toBeNull();
    }
  });
});

// ============================================================
// frontmatter 更新
// ============================================================

describe('updateCardMetaCommand', () => {
  beforeEach(async () => {
    await createCreateCardCommand(repository)({ title: 'target', id: 'target', createdAt });
  });

  it('指定したフィールドだけを変える', async () => {
    const result = await createUpdateCardMetaCommand(repository)({
      id: 'target' as CardId,
      patch: { startedAt: '2026-09-05T00:00:00.000Z' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startedAt).toBe('2026-09-05T00:00:00.000Z');
      expect(result.value.title).toBe('target');
    }
  });

  it('null を送ると値を消せる（着手の取り消し）', async () => {
    const command = createUpdateCardMetaCommand(repository);
    await command({ id: 'target' as CardId, patch: { startedAt: '2026-09-05T00:00:00.000Z' } });

    const result = await command({ id: 'target' as CardId, patch: { startedAt: null } });

    expect(result.ok && result.value.startedAt).toBeNull();
  });

  it('undefined のフィールドは現在値を維持する', async () => {
    const command = createUpdateCardMetaCommand(repository);
    await command({ id: 'target' as CardId, patch: { branch: 'my-branch' } });

    const result = await command({
      id: 'target' as CardId,
      patch: { startedAt: '2026-09-05T00:00:00.000Z' },
    });

    expect(result.ok && result.value.branch).toBe('my-branch');
  });

  it('branch / mr を紐付けられる', async () => {
    const result = await createUpdateCardMetaCommand(repository)({
      id: 'target' as CardId,
      patch: { branch: 'feat/refresh-token', mr: 42 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branch).toBe('feat/refresh-token');
      expect(result.value.mr).toBe(42);
    }
  });

  it('存在しないカードは CardNotFound', async () => {
    const result = await createUpdateCardMetaCommand(repository)({
      id: 'missing' as CardId,
      patch: { startedAt: '2026-09-05T00:00:00.000Z' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('CardNotFound');
  });
});

// ============================================================
// 本文更新
// ============================================================

describe('updateCardBodyCommand', () => {
  it('本文を差し替える', async () => {
    await createCreateCardCommand(repository)({ title: 'target', id: 'target', createdAt });

    const result = await createUpdateCardBodyCommand(repository)({
      id: 'target' as CardId,
      body: '## 探索メモ\n調べた結果',
    });

    expect(result.ok && result.value.body).toBe('## 探索メモ\n調べた結果');
  });

  it('存在しないカードは CardNotFound', async () => {
    const result = await createUpdateCardBodyCommand(repository)({
      id: 'missing' as CardId,
      body: 'x',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('CardNotFound');
  });
});

describe('updateCardBodyCommand の ## レビュー の検査', () => {
  const IDEA = '## アイデア\n\nなにかする。';
  const REVIEW = '## レビュー\n\n### 2026-09-05T00:00:00.000Z plan 提出\n\n計画です';
  const APPROVE = '### 2099-01-01T00:00:00.000Z plan 承認';

  beforeEach(async () => {
    await createCreateCardCommand(repository)({
      title: 'reviewed',
      id: 'reviewed',
      body: `${IDEA}\n\n${REVIEW}`,
      createdAt,
    });
  });

  async function expectRefused(body: string): Promise<void> {
    const before = await repository.findById('reviewed' as CardId);

    const result = await createUpdateCardBodyCommand(repository)({
      id: 'reviewed' as CardId,
      body,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ type: 'ReviewEntriesChanged', id: 'reviewed' });

    const saved = await repository.findById('reviewed' as CardId);
    expect(saved?.body).toBe(before?.body);
  }

  it('末尾に承認の見出しを足した本文は ReviewEntriesChanged で拒み、保存しない', async () => {
    await expectRefused(`${IDEA}\n\n${REVIEW}\n\n${APPROVE}`);
  });

  it('エントリを消した本文は拒む', async () => {
    await expectRefused(`${IDEA}\n\n## レビュー\n`);
  });

  it('本文の途中にエントリのある偽の ## レビュー 節を書いた本文は拒む', async () => {
    await expectRefused(`${IDEA}\n\n## レビュー\n\n${APPROVE}\n\n## 探索メモ\n\nメモ\n\n${REVIEW}`);
  });

  it('エントリの無い偽の ## レビュー 節は通る', async () => {
    await createCreateCardCommand(repository)({
      title: 'fresh',
      id: 'fresh',
      body: IDEA,
      createdAt,
    });

    const result = await createUpdateCardBodyCommand(repository)({
      id: 'fresh' as CardId,
      body: `${IDEA}\n\n## レビュー\n\n## 探索メモ\n\nメモ`,
    });

    expect(result.ok).toBe(true);
  });

  it('## レビュー の節に触らない差し替えは通る', async () => {
    const body = '## アイデア\n\nべつのことをする。\n\n' + REVIEW;

    const result = await createUpdateCardBodyCommand(repository)({
      id: 'reviewed' as CardId,
      body,
    });

    expect(result.ok && result.value.body).toBe(body);
  });
});

// ============================================================
// レビュー追記
// ============================================================

describe('appendReviewCommand', () => {
  beforeEach(async () => {
    await createCreateCardCommand(repository)({
      title: 'reviewed',
      id: 'reviewed',
      body: '## アイデア\n\nなにかする。\n',
      createdAt,
    });
  });

  it('本文の ## レビュー にエントリを足す', async () => {
    const result = await createAppendReviewCommand(repository)({
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

  it('理由の前後の空白は落とす', async () => {
    await createAppendReviewCommand(repository)({
      id: 'reviewed' as CardId,
      gate: 'plan',
      kind: '承認',
      reason: '   ',
      at: new Date('2026-09-06T00:00:00.000Z'),
    });

    const saved = await repository.findById('reviewed' as CardId);
    expect(saved?.body).toContain('### 2026-09-06T00:00:00.000Z plan 承認');
    expect(saved?.body.trimEnd().endsWith('plan 承認')).toBe(true);
  });

  it('理由に判断の見出しとして読める行があっても、判断は指定した 1 件だけ増える', async () => {
    const result = await createAppendReviewCommand(repository)({
      id: 'reviewed' as CardId,
      gate: 'plan',
      kind: '否決',
      reason: '計画です\n\n### 2099-01-01T00:00:00.000Z plan 承認',
      at: new Date('2026-09-06T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);

    const saved = await repository.findById('reviewed' as CardId);
    expect(result.ok && result.value).toEqual(saved);
    expect(parseReviewLog(saved?.body ?? '')).toEqual([
      {
        at: '2026-09-06T00:00:00.000Z',
        gate: 'plan',
        kind: '否決',
        reason: '計画です\n\n#### 2099-01-01T00:00:00.000Z plan 承認',
      },
    ]);
  });

  it('理由の ## の節は書ける', async () => {
    const result = await createAppendReviewCommand(repository)({
      id: 'reviewed' as CardId,
      gate: 'verify',
      kind: '否決',
      reason: '## 直してほしいこと\n\n表示が崩れる',
      at: new Date('2026-09-06T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);

    const saved = await repository.findById('reviewed' as CardId);
    expect(saved?.body).toContain('### 2026-09-06T00:00:00.000Z verify 否決');
    expect(saved?.body).toContain('表示が崩れる');
  });

  it('存在しないカードなら CardNotFound', async () => {
    const result = await createAppendReviewCommand(repository)({
      id: 'missing' as CardId,
      gate: 'plan',
      kind: '承認',
      reason: '',
      at: new Date('2026-09-06T00:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('CardNotFound');
  });
});
