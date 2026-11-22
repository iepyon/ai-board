import { describe, expect, it } from 'vitest';
import { err, isErr, ok } from '../../shared/result.js';
import { STORE_VERSION, type DocumentStore } from '../document-store.js';

// ============================================================
// 置き場所の口の約束 — どの実装にも同じテストを当てる
// ============================================================

/**
 * `DocumentStore` の実装が口の約束を守るかを確かめる。
 *
 * `make` は `board/meta`（今の形の版）だけが入った、読み書きできる置き場所を返す。
 * 各テストは CLI と同じく、読む前に `check()` を 1 回 `await` してから使う。
 * SQLite の実装を足すときも、このテストを当てる。
 */
export function describeDocumentStoreContract(
  name: string,
  make: () => DocumentStore | Promise<DocumentStore>
): void {
  /** 置き場所を作り、CLI と同じく check を通してから返す */
  async function open(): Promise<DocumentStore> {
    const store = await make();
    expect(await store.check()).toEqual(ok(undefined));
    return store;
  }

  describe(`DocumentStore の約束: ${name}`, () => {
    it('初めの状態で check が通り、形の版が読める', async () => {
      const store = await open();
      expect(store.get('board', 'meta')).toEqual({ version: STORE_VERSION });
    });

    it('transact で書いたものが、その中でもその後でも読める', async () => {
      const store = await open();
      const result = await store.transact('書く', () => {
        store.set('cards', 'a', { title: 'A' });
        expect(store.get('cards', 'a')).toEqual({ title: 'A' });
        return Promise.resolve(ok('done'));
      });
      expect(result).toEqual(ok('done'));
      expect(store.get('cards', 'a')).toEqual({ title: 'A' });
    });

    it('同じ文書を書き直すと最新の中身になる', async () => {
      const store = await open();
      await store.transact('1', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(ok(undefined));
      });
      await store.transact('2', () => {
        store.set('cards', 'a', { title: 'B' });
        store.set('cards', 'a', { title: 'C' });
        return Promise.resolve(ok(undefined));
      });
      expect(store.get('cards', 'a')).toEqual({ title: 'C' });
      expect(store.list('cards')).toEqual([{ id: 'a', data: { title: 'C' } }]);
    });

    it('list は ID の昇順で返す', async () => {
      const store = await open();
      await store.transact('書く', () => {
        store.set('log', 'b', { n: 2 });
        store.set('log', 'a', { n: 1 });
        store.set('log', 'c', { n: 3 });
        return Promise.resolve(ok(undefined));
      });
      expect(store.list('log').map((doc) => doc.id)).toEqual(['a', 'b', 'c']);
    });

    it('消した文書は get でも list でも見えない', async () => {
      const store = await open();
      await store.transact('書く', () => {
        store.set('cards', 'a', { title: 'A' });
        store.set('cards', 'b', { title: 'B' });
        return Promise.resolve(ok(undefined));
      });
      await store.transact('消す', () => {
        store.delete('cards', 'a');
        store.delete('cards', 'missing');
        return Promise.resolve(ok(undefined));
      });
      expect(store.get('cards', 'a')).toBeNull();
      expect(store.list('cards').map((doc) => doc.id)).toEqual(['b']);
    });

    it('op が Err を返したら、その中の書き込みは無かったことになる', async () => {
      const store = await open();
      const result = await store.transact('拒む', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(err({ type: 'Refused' as const }));
      });
      expect(result).toEqual(err({ type: 'Refused' }));
      expect(store.get('cards', 'a')).toBeNull();
    });

    it('op が例外を投げたら、その中の書き込みは無かったことになり、例外はそのまま届く', async () => {
      const store = await open();
      await expect(
        store.transact('壊れる', () => {
          store.set('cards', 'a', { title: 'A' });
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(store.get('cards', 'a')).toBeNull();
      // 次の transact は普通に通る（ロックが残っていない）
      const next = await store.transact('次', () => Promise.resolve(ok(1)));
      expect(isErr(next)).toBe(false);
    });

    it('transact の外での書き込みは呼び出し側の誤りとして例外を投げる', async () => {
      const store = await open();
      expect(() => store.set('cards', 'a', { title: 'A' })).toThrow();
      expect(() => store.delete('cards', 'a')).toThrow();
    });

    it('ID に使えない文字は呼び出し側の誤りとして例外を投げる', async () => {
      const store = await open();
      await expect(
        store.transact('誤り', () => {
          store.set('cards', 'a~1', { title: 'A' });
          return Promise.resolve(ok(undefined));
        })
      ).rejects.toThrow();
      await expect(
        store.transact('誤り', () => {
          store.set('cards', '..', { title: 'A' });
          return Promise.resolve(ok(undefined));
        })
      ).rejects.toThrow();
    });

    it('同じプロセスの transact は 1 列に並ぶ', async () => {
      const store = await open();
      const order: string[] = [];
      const slow = store.transact('遅い', async () => {
        order.push('slow:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        store.set('cards', 'a', { n: 1 });
        order.push('slow:end');
        return ok(undefined);
      });
      const fast = store.transact('速い', () => {
        order.push('fast');
        store.set('cards', 'a', {
          n: ((store.get('cards', 'a')?.n as number | undefined) ?? 0) + 10,
        });
        return Promise.resolve(ok(undefined));
      });
      await Promise.all([slow, fast]);
      expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
      expect(store.get('cards', 'a')).toEqual({ n: 11 });
    });

    it('pendingWrites は数を返す', async () => {
      const store = await open();
      expect(store.pendingWrites()).toBeGreaterThanOrEqual(0);
    });
  });
}
