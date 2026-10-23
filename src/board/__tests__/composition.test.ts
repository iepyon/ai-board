import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database.js';
import type { CliRunner } from '../../infrastructure/cli-runner.js';
import { createCardDependencies } from '../../cards/composition.js';
import { ok, err } from '../../shared/result.js';
import type { ForgeConfig } from '../../shared/config.js';
import { ForgePoller } from '../../infrastructure/forge-poller.js';
import { createMrStateSource } from '../composition.js';

// ============================================================
// レビュー要求の状態の供給元
// ============================================================

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

const forge: ForgeConfig = { kind: 'github', owner: 'acme', repo: 'board' };

/** `gh auth status` の成否だけを決める偽の CLI */
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
    const { cardRepository } = createCardDependencies(db);
    const source = await createMrStateSource(null, cardRepository, authRunner(true));

    expect(source.poller).toBeNull();
    expect(source.provider.connection()).toEqual({ status: 'disabled', kind: null, reason: null });
  });

  it('gh が使えなければ、理由付きの disabled を返す', async () => {
    const { cardRepository } = createCardDependencies(db);
    const source = await createMrStateSource(forge, cardRepository, authRunner(false));

    expect(source.poller).toBeNull();
    expect(source.provider.connection()).toMatchObject({ status: 'disabled', kind: 'github' });
    expect(source.provider.connection()).not.toMatchObject({ reason: null });
  });

  it('gh が使えれば、ポーラーを供給元にする', async () => {
    const { cardRepository } = createCardDependencies(db);
    const source = await createMrStateSource(forge, cardRepository, authRunner(true));

    expect(source.poller).toBeInstanceOf(ForgePoller);
    expect(source.provider).toBe(source.poller);
    expect(source.provider.connection()).toEqual({ status: 'connected', kind: 'github' });
  });
});
