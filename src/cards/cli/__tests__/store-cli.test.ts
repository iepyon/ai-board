import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from '../../../shared/result.js';
import { ArtifactMirrorStore } from '../../../infrastructure/artifact-mirror-store.js';
import { STORE_VERSION } from '../../../infrastructure/document-store.js';
import type { ImportDocument } from '../../repositories/data-branch-import.js';
import {
  isStoreCommand,
  runStoreCli,
  STORE_USAGE,
  type StoreCliDependencies,
} from '../store-cli.js';

let tmp: string;
let store: ArtifactMirrorStore;
let stdout: string;
let stderr: string;
let importResult: Result<ImportDocument[], string>;
let seedCalls: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-store-cli-'));
  store = new ArtifactMirrorStore(path.join(tmp, 'store'));
  stdout = '';
  stderr = '';
  importResult = ok([]);
  seedCalls = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deps(): StoreCliDependencies {
  return {
    store,
    readDataBranch: vi.fn(() => importResult),
    runSeed: (dir) => {
      seedCalls.push(dir);
      return Promise.resolve(0);
    },
    seedDir: '/repo/.ai-board/seed',
  };
}

function run(argv: readonly string[]): Promise<number> {
  return runStoreCli(argv, deps(), {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
}

/** `ArtifactData` の out_dir が書く形のディレクトリを作る */
function writeExport(name: string, docs: Record<string, Record<string, unknown>>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, data] of Object.entries(docs)) {
    const full = path.join(dir, `${file}.json`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(data));
  }
  return dir;
}

async function pullMeta(): Promise<void> {
  expect(
    await run([
      'pull',
      '--from',
      writeExport('meta', { 'board/meta~000001': { version: STORE_VERSION } }),
    ])
  ).toBe(0);
  stdout = '';
  stderr = '';
}

describe('runStoreCli', () => {
  it('コマンドが無い・--help なら使い方を出して 0、不明なら 1', async () => {
    expect(await run([])).toBe(0);
    expect(stderr).toBe(STORE_USAGE);

    stderr = '';
    expect(await run(['outbox', '--help'])).toBe(0);
    expect(stderr).toBe(STORE_USAGE);

    stderr = '';
    expect(await run(['push'])).toBe(1);
    expect(stderr).toContain('不明なコマンドです: push');
  });

  it('不明な引数・値の無い --from は 1', async () => {
    expect(await run(['ack', '--force'])).toBe(1);
    expect(stderr).toContain('不明な引数です: --force');

    stderr = '';
    expect(await run(['pull', '--from'])).toBe(1);
    expect(stderr).toContain('--from には値を指定してください');
  });

  it('isStoreCommand は規定のコマンドだけを受ける', () => {
    expect(isStoreCommand('pull')).toBe(true);
    expect(isStoreCommand('push')).toBe(false);
    expect(isStoreCommand(undefined)).toBe(false);
  });

  describe('pull', () => {
    it('out_dir の書き出しを写しに取り込み、件数を出す', async () => {
      const dir = writeExport('e', {
        'board/meta~000001': { version: STORE_VERSION },
        'cards/a~000001': { title: 'A' },
      });

      expect(await run(['pull', '--from', dir])).toBe(0);

      expect(stdout).toBe('2 件の文書を写しに取り込みました\n');
      expect(stderr).toBe('');
      expect(store.get('cards', 'a')).toEqual({ title: 'A' });
    });

    it('取り込んだ置き場所が空（board/meta が無い）なら、取り込んだうえで init を案内する', async () => {
      expect(await run(['pull', '--from', writeExport('empty', {})])).toBe(0);
      expect(stdout).toBe('0 件の文書を写しに取り込みました\n');
      expect(stderr).toContain('ai-board store init');
    });

    it('--from が無ければ 1', async () => {
      expect(await run(['pull'])).toBe(1);
      expect(stderr).toContain('--from');
    });

    it('送る箱が空でなければ拒む', async () => {
      await pullMeta();
      expect(await run(['init'])).toBe(1); // 既に始まっている
      await store.transact('1', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(ok(undefined));
      });

      expect(await run(['pull', '--from', writeExport('again', {})])).toBe(1);
      expect(stderr).toContain('送っていない書き込みが 1 件');
    });

    it('読めない文書があれば 1 で、写しを変えない', async () => {
      await pullMeta();
      const dir = writeExport('bad', { 'board/meta~000001': { version: STORE_VERSION } });
      fs.mkdirSync(path.join(dir, 'cards'));
      fs.writeFileSync(path.join(dir, 'cards', 'a~000001.json'), 'not json');

      expect(await run(['pull', '--from', dir])).toBe(1);
      expect(stderr).toContain('取り込もうとした文書が読めません');
      expect(await store.check()).toEqual(ok(undefined));
    });
  });

  describe('outbox / ack / discard', () => {
    it('outbox --json は batch の writes にそのまま渡せる形で出す', async () => {
      await pullMeta();
      await store.transact('a を作る', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(ok(undefined));
      });

      expect(await run(['outbox', '--json'])).toBe(0);

      const parsed = JSON.parse(stdout) as { batches: { label: string; writes: unknown[] }[] };
      expect(parsed.batches).toEqual([
        {
          seq: '000001',
          label: 'a を作る',
          writes: [
            {
              op: 'set',
              collection: 'cards',
              doc_id: 'a~000001',
              file_path: path.join(store.outboxDir, 'docs', '000001-1.json'),
            },
          ],
        },
      ]);
    });

    it('outbox は人向けに束の名前と件数を並べ、空ならそう出す', async () => {
      expect(await run(['outbox'])).toBe(0);
      expect(stdout).toBe('送る箱は空です\n');

      await pullMeta();
      await store.transact('a を作る', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(ok(undefined));
      });
      expect(await run(['outbox'])).toBe(0);
      expect(stdout).toBe('a を作る（1 件）\n');
    });

    it('ack --through は送り終えた束だけを消し、後から積んだ束と写しは残す', async () => {
      await pullMeta();
      await store.transact('a を作る', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(ok(undefined));
      });
      // outbox を読んで送っている間に、ほかのプロセスが積んだ束
      await store.transact('b を作る', () => {
        store.set('cards', 'b', { title: 'B' });
        return Promise.resolve(ok(undefined));
      });

      expect(await run(['ack', '--through', '000001'])).toBe(0);

      expect(stdout).toContain('送り終えた 1 束を送る箱から消しました（残り 1 束）');
      expect(store.outbox().map((batch) => batch.label)).toEqual(['b を作る']);
      expect(store.get('cards', 'a')).toEqual({ title: 'A' });
    });

    it('ack は --through が無い・連番の形でなければ拒み、送る箱を変えない', async () => {
      await pullMeta();
      await store.transact('a を作る', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(ok(undefined));
      });

      expect(await run(['ack'])).toBe(1);
      expect(await run(['ack', '--through', '1'])).toBe(1);
      expect(stderr).toContain('--through');
      expect(store.pendingWrites()).toBe(1);
    });

    it('discard は送る箱を捨て、写しを積む前に戻す', async () => {
      await pullMeta();
      await store.transact('a を作る', () => {
        store.set('cards', 'a', { title: 'A' });
        return Promise.resolve(ok(undefined));
      });

      expect(await run(['discard'])).toBe(0);

      expect(stdout).toContain('送る箱を捨て、写しを戻しました（1 束）');
      expect(store.pendingWrites()).toBe(0);
      expect(store.get('cards', 'a')).toBeNull();
    });
  });

  describe('init', () => {
    it('空の置き場所に board/meta を積む', async () => {
      expect(await run(['init'])).toBe(0);

      expect(stdout).toContain('送る箱に積みました');
      expect(
        store.outbox()[0]?.writes.map((write) => `${write.collection}/${write.doc_id}`)
      ).toEqual(['board/meta~000001']);
      expect(await store.check()).toEqual(ok(undefined));
    });

    it('既に始まっていれば 1 で、何も積まない', async () => {
      await pullMeta();

      expect(await run(['init'])).toBe(1);

      expect(stderr).toContain('既に始まっています');
      expect(store.pendingWrites()).toBe(0);
    });
  });

  describe('import', () => {
    const docs: ImportDocument[] = [
      { collection: 'order', id: 'order', data: { divider: null, ranks: { a: 1 } } },
      { collection: 'cards', id: 'a', data: { id: 'a', title: 'A' } },
      { collection: 'log', id: 'a.20261101T000000.000Z.plan.submit', data: { reason: '' } },
    ];

    it('データ用ブランチの文書を 1 束で積み、カードの枚数を出す', async () => {
      await pullMeta();
      importResult = ok(docs);

      expect(await run(['import', '--from', '/clone'])).toBe(0);

      expect(stdout).toContain('1 枚のカードと 2 件の文書');
      expect(store.outbox()).toHaveLength(1);
      expect(store.get('cards', 'a')).toEqual({ id: 'a', title: 'A' });
    });

    it('写しにカードが 1 枚でもあれば拒み、何も積まない', async () => {
      await pullMeta();
      await store.transact('前から', () => {
        store.set('cards', 'x', { title: 'X' });
        return Promise.resolve(ok(undefined));
      });
      await store.ack('999999');
      importResult = ok(docs);

      expect(await run(['import', '--from', '/clone'])).toBe(1);

      expect(stderr).toContain('既にカードがあるため');
      expect(store.pendingWrites()).toBe(0);
    });

    it('写しが無い・クローンが読めない・--from が無いときは 1', async () => {
      expect(await run(['import', '--from', '/clone'])).toBe(1);
      expect(stderr).toContain('写しがありません');

      await pullMeta();
      importResult = err('ai-board-data.yaml がありません');
      expect(await run(['import', '--from', '/clone'])).toBe(1);
      expect(stderr).toContain('ai-board-data.yaml がありません');

      stderr = '';
      expect(await run(['import'])).toBe(1);
      expect(stderr).toContain('--from');
    });
  });

  describe('seed', () => {
    it('既定は .ai-board/seed/ を card seed に渡し、--from があればそれを渡す', async () => {
      expect(await run(['seed'])).toBe(0);
      expect(await run(['seed', '--from', 'other'])).toBe(0);

      expect(seedCalls).toEqual(['/repo/.ai-board/seed', 'other']);
    });
  });
});
