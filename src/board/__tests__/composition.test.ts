import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliRunner } from '../../infrastructure/cli-runner.js';
import { createFileCardDependencies } from '../../cards/composition.js';
import { ok, err } from '../../shared/result.js';
import type { ForgeConfig } from '../../shared/config.js';
import { ForgePoller } from '../../infrastructure/forge-poller.js';
import { createMrStateSource } from '../composition.js';
import type { MrSnapshotRepository } from '../repositories/mr-snapshot.repository.js';
import type { MrSnapshot } from '../models/mr-state.js';
import type { Card } from '../../cards/models/card.js';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';

// ============================================================
// レビュー要求の状態の供給元
// ============================================================

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-composition-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 控えを持たないリポジトリ。ここでは供給元の組み立てだけを確かめる */
const noSnapshots: MrSnapshotRepository = {
  findAll: () => Promise.resolve(new Map()),
  findMerged: () => Promise.resolve(new Map()),
  save: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

const forge: ForgeConfig = { kind: 'github', owner: 'acme', repo: 'board' };

/** 接続の確かめ（`gh api repos/<owner>/<repo>`）の成否だけを決める偽の CLI */
function authRunner(loggedIn: boolean): CliRunner {
  return {
    run: () =>
      Promise.resolve(
        loggedIn
          ? ok('')
          : err({ type: 'Failed', command: 'gh', message: 'not logged in', httpStatus: null })
      ),
  };
}

describe('createMrStateSource', () => {
  it('取得先が未設定なら、問い合わせずに disabled を返す', async () => {
    const { cardRepository } = createFileCardDependencies(dataDir);
    const source = await createMrStateSource(null, cardRepository, noSnapshots, authRunner(true));

    expect(source.poller).toBeNull();
    expect(source.provider.connection()).toEqual({ status: 'disabled', kind: null, reason: null });
  });

  it('gh が使えなければ、理由付きの disabled を返す', async () => {
    const { cardRepository } = createFileCardDependencies(dataDir);
    const source = await createMrStateSource(forge, cardRepository, noSnapshots, authRunner(false));

    expect(source.poller).toBeNull();
    expect(source.provider.connection()).toMatchObject({ status: 'disabled', kind: 'github' });
    expect(source.provider.connection()).not.toMatchObject({ reason: null });
  });

  it('gh が使えれば、ポーラーを供給元にする', async () => {
    const { cardRepository } = createFileCardDependencies(dataDir);
    const source = await createMrStateSource(forge, cardRepository, noSnapshots, authRunner(true));

    expect(source.poller).toBeInstanceOf(ForgePoller);
    expect(source.provider).toBe(source.poller);
    expect(source.provider.connection()).toEqual({ status: 'connected', kind: 'github' });
  });

  describe('gh が使えないとき', () => {
    function card(id: string, mr: number | null): Card {
      return {
        id: id as CardId,
        title: id,
        created: '2026-11-01T00:00:00.000Z',
        startedAt: '2026-11-02T00:00:00.000Z',
        skipGates: [],
        branch: id,
        mr: mr as MergeRequestIid | null,
        rank: null,
        body: '',
      };
    }

    function merged(iid: number): MrSnapshot {
      return {
        fingerprint: `[${iid}]`,
        mr: {
          forge: 'github',
          iid: iid as MergeRequestIid,
          state: 'merged',
          draft: false,
          sourceBranch: 'x',
          title: 'x',
          webUrl: `https://github.com/acme/board/pull/${iid}`,
          latestNoteAt: null,
          noteCount: 0,
          latestAiNoteAt: null,
          latestCommitAt: null,
          mergedAt: '2026-11-04T00:00:00Z',
          readyAt: '2026-11-03T00:00:00Z',
          convertedToDraftAt: null,
        },
      };
    }

    /** マージ済みの控えの読み方だけを差し替えたリポジトリ */
    function snapshots(findMerged: MrSnapshotRepository['findMerged']): MrSnapshotRepository {
      return { ...noSnapshots, findMerged };
    }

    it('マージ済みの控えのうち、カードの PR 番号と合うものだけを返す', async () => {
      const { cardRepository } = createFileCardDependencies(dataDir);
      await cardRepository.create(card('done', 7));
      await cardRepository.create(card('renumbered', 9));
      const repository = snapshots(() =>
        Promise.resolve(
          new Map([
            ['done' as CardId, merged(7)],
            ['renumbered' as CardId, merged(8)],
          ])
        )
      );

      const source = await createMrStateSource(
        forge,
        cardRepository,
        repository,
        authRunner(false)
      );

      expect(source.poller).toBeNull();
      expect(source.provider.connection()).toMatchObject({ status: 'disabled', kind: 'github' });
      expect(source.provider.get('done')).toEqual(merged(7).mr);
      expect(source.provider.get('renumbered')).toBeNull();
    });

    it('控えを読めなければ、警告してすべて null にする', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { cardRepository } = createFileCardDependencies(dataDir);
      await cardRepository.create(card('done', 7));
      const repository = snapshots(() => Promise.reject(new Error('壊れた')));

      const source = await createMrStateSource(
        forge,
        cardRepository,
        repository,
        authRunner(false)
      );

      expect(source.provider.get('done')).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('壊れた'));
      warn.mockRestore();
    });
  });
});
