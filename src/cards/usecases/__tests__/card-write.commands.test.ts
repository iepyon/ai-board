import { describe, it, expect, beforeEach } from 'vitest';
import type {
  CommitMessage,
  DataOperation,
  DataStore,
} from '../../../infrastructure/data-store.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import { createLinkCardBranchCommand } from '../commands/link-card-branch.command.js';
import { createCardWriteCommands } from '../commands/card-write.commands.js';
import { createCreateCardCommand } from '../commands/create-card.command.js';
import { createUpdateCardBodyCommand } from '../commands/update-card-body.command.js';
import { createSubmitReviewCommand } from '../commands/submit-review.command.js';
import { createHoldReviewCommand } from '../commands/hold-review.command.js';
import { appendReviewEntry } from '../../services/review-log.js';

// ============================================================
// テストダブル
// ============================================================

/** 書き込みの usecase が使うところだけを持つ、メモリのリポジトリ */
class MemoryCards implements CardRepository {
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

  async appendReview(id: CardId, entry: Parameters<CardRepository['appendReview']>[1]) {
    const card = this.cards.get(id);
    if (card === undefined) return false;
    this.cards.set(id, { ...card, body: appendReviewEntry(card.body, entry) });
    return true;
  }
}

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id: id as CardId,
    title: `${id} のタイトル`,
    created: '2026-11-01T00:00:00.000Z',
    startedAt: '2026-11-02T00:00:00.000Z',
    skipGates: ['plan'],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

let repository: MemoryCards;
let commits: string[];

/** `op` を 1 回走らせ、通ったらコミットしたことにしてメッセージを控える試しの store */
const store: Pick<DataStore, 'transact'> = {
  transact: async <T, E>(message: CommitMessage<T>, op: DataOperation<T, E>) => {
    const result = await op('unused');
    if (result.ok) commits.push(typeof message === 'string' ? message : message(result.value));
    return result;
  },
};

function writes() {
  return createCardWriteCommands(store, {
    createCardCommand: createCreateCardCommand(repository),
    updateCardBodyCommand: createUpdateCardBodyCommand(repository),
    linkCardBranchCommand: createLinkCardBranchCommand(repository),
    submitReviewCommand: createSubmitReviewCommand(repository),
    holdReviewCommand: createHoldReviewCommand(repository),
  });
}

beforeEach(() => {
  repository = new MemoryCards();
  commits = [];
});

// ============================================================
// ブランチの紐付け
// ============================================================

describe('createLinkCardBranchCommand', () => {
  it('branch だけを書き換え、startedAt と skipGates は保つ', async () => {
    repository.cards.set('a', card('a'));

    const linked = await createLinkCardBranchCommand(repository)({
      id: 'a' as CardId,
      branch: 'feat/a',
    });

    expect(linked.ok).toBe(true);
    expect(repository.cards.get('a')).toMatchObject({
      branch: 'feat/a',
      startedAt: '2026-11-02T00:00:00.000Z',
      skipGates: ['plan'],
    });
  });

  it('null なら紐付けを外す', async () => {
    repository.cards.set('a', card('a', { branch: 'feat/a' }));

    await createLinkCardBranchCommand(repository)({ id: 'a' as CardId, branch: null });

    expect(repository.cards.get('a')?.branch).toBeNull();
  });

  it('カードが無ければ CardNotFound', async () => {
    const result = await createLinkCardBranchCommand(repository)({
      id: 'missing' as CardId,
      branch: 'x',
    });

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'missing' } });
  });
});

// ============================================================
// 書き込みの 1 操作とコミットのメッセージ
// ============================================================

describe('createCardWriteCommands', () => {
  it('操作ごとにコミットのメッセージを決める。ブランチ名と理由は入れない', async () => {
    const w = writes();
    const at = new Date('2026-11-06T00:00:00.000Z');

    await w.create({ title: 'x', id: 'a', createdAt: at });
    await w.replaceBody({ id: 'a' as CardId, body: '本文' });
    await w.linkBranch({ id: 'a' as CardId, branch: 'feat/secret' });
    await w.linkBranch({ id: 'a' as CardId, branch: null });
    repository.cards.set('a', { ...repository.cards.get('a')!, startedAt: at.toISOString() });
    await w.submit({ id: 'a' as CardId, gate: 'plan', resubmit: false, reason: '秘密', at });

    expect(commits).toEqual([
      'data: a を作る',
      'data: a の本文を差し替える',
      'data: a にブランチを紐付ける',
      'data: a のブランチを外す',
      'data: a に plan 提出 を足す',
    ]);
  });

  it('再提出と保留のメッセージにはゲートと種別を入れる', async () => {
    const at = new Date('2026-11-06T00:00:00.000Z');
    const sentBack = '## レビュー\n\n### 2026-11-03T00:00:00.000Z plan 差し戻し\n\n直して\n';
    repository.cards.set('a', card('a', { body: sentBack }));
    repository.cards.set('b', card('b', { body: sentBack }));
    const w = writes();

    await w.hold({ id: 'a' as CardId, gate: 'plan', reason: '決めて', at });
    await w.submit({ id: 'b' as CardId, gate: 'plan', resubmit: true, reason: '', at });

    expect(commits).toEqual(['data: a に plan 保留 を足す', 'data: b に plan 再提出 を足す']);
  });

  it('usecase が拒んだ書き込みはコミットしない', async () => {
    repository.cards.set('a', card('a', { startedAt: null }));

    const result = await writes().submit({
      id: 'a' as CardId,
      gate: 'plan',
      resubmit: false,
      reason: '',
      at: new Date(),
    });

    expect(result).toMatchObject({ ok: false, error: { type: 'SubmitBeforeStart' } });
    expect(commits).toEqual([]);
  });
});
