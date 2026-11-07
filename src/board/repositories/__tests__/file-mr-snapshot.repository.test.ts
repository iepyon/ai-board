import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import {
  createDataStore,
  DATA_BRANCH,
  type DataStore,
} from '../../../infrastructure/data-store.js';
import {
  FileMrSnapshotRepository,
  parseMrSnapshot,
  MR_SNAPSHOT_CACHE_FILE,
  SNAPSHOTS_DIR,
} from '../file-mr-snapshot.repository.js';
import type { MrSnapshot } from '../../models/mr-state.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';

// ============================================================
// 一時ディレクトリの bare リポジトリを origin にして、本物の git で確かめる
// ============================================================

let tmp: string;
let origin: string;
const runner = createCliRunner({ timeoutMs: 30_000 });

vi.setConfig({ testTimeout: 30_000 });

function sh(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd: string, ...args: string[]): string {
  return sh(['-C', cwd, ...args]).trim();
}

/** clone ごとに親を分ける。使い捨ての控えはデータのワークツリーの親に置かれる */
function cloneData(name: string): DataStore {
  const parent = path.join(tmp, name);
  fs.mkdirSync(parent, { recursive: true });
  const dataDir = path.join(parent, 'data');
  sh(['clone', '--quiet', '--branch', DATA_BRANCH, origin, dataDir]);
  return createDataStore({ dataDir, runner, lockPollMs: 10 });
}

function originLog(): string[] {
  return git(origin, 'log', '--format=%s', DATA_BRANCH).split('\n');
}

function originFiles(): string[] {
  return git(origin, 'ls-tree', '-r', '--name-only', DATA_BRANCH).split('\n');
}

function cacheFile(store: DataStore): string {
  return path.join(path.dirname(store.dataDir), MR_SNAPSHOT_CACHE_FILE);
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const id = 'refresh-token' as CardId;

function makeSnapshot(overrides: Partial<MrSnapshot['mr']> = {}): MrSnapshot {
  return {
    fingerprint: '[1,"open"]',
    mr: {
      forge: 'github',
      iid: 42 as MergeRequestIid,
      state: 'opened',
      draft: true,
      sourceBranch: 'refresh-token',
      title: 'リフレッシュトークン対応',
      webUrl: 'https://github.com/acme/board/pull/42',
      latestNoteAt: '2026-09-04T10:00:00Z',
      noteCount: 3,
      latestAiNoteAt: null,
      latestCommitAt: null,
      mergedAt: null,
      readyAt: null,
      convertedToDraftAt: null,
      ...overrides,
    },
  };
}

function merged(overrides: Partial<MrSnapshot['mr']> = {}): MrSnapshot {
  return {
    ...makeSnapshot({
      state: 'merged',
      draft: false,
      mergedAt: '2026-09-05T00:00:00Z',
      readyAt: '2026-09-04T09:00:00Z',
      ...overrides,
    }),
    fingerprint: '[1,"closed"]',
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-mr-snapshot-'));

  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  origin = path.join(tmp, 'origin.git');
  sh(['init', '--quiet', '--bare', origin]);

  const seed = path.join(tmp, 'seed');
  sh(['clone', '--quiet', origin, seed]);
  git(seed, 'checkout', '--quiet', '--orphan', DATA_BRANCH);
  write(path.join(seed, 'ai-board-data.yaml'), 'version: 1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'data: 始める');
  git(seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('FileMrSnapshotRepository の開いている PR の控え', () => {
  it('使い捨ての JSON に書き、データ用ブランチにはコミットしない', async () => {
    const store = cloneData('a');
    const repository = new FileMrSnapshotRepository(store);

    await repository.save(id, makeSnapshot());

    expect(await repository.findAll()).toEqual(new Map([[id, makeSnapshot()]]));
    expect(fs.existsSync(cacheFile(store))).toBe(true);
    expect(originLog()).toEqual(['data: 始める']);
  });

  it('書き直すと上書きする', async () => {
    const repository = new FileMrSnapshotRepository(cloneData('a'));

    await repository.save(id, makeSnapshot());
    await repository.save(id, { ...makeSnapshot({ draft: false }), fingerprint: 'next' });

    const found = await repository.findAll();
    expect(found.size).toBe(1);
    expect(found.get(id)?.fingerprint).toBe('next');
    expect(found.get(id)?.mr.draft).toBe(false);
  });

  it('マージ済みの控えが無ければ、書くのも消すのも取り直しと push を走らせない', async () => {
    // 開いている PR の控えは指紋が変わるたびに書かれる。そのたびに fetch と push を走らせない
    const store = cloneData('a');
    const transact = vi.spyOn(store, 'transact');
    const repository = new FileMrSnapshotRepository(store);

    await repository.save(id, makeSnapshot());
    await repository.delete(id);

    expect(transact).not.toHaveBeenCalled();
    expect((await repository.findAll()).size).toBe(0);
  });

  it('ほかの clone の使い捨ての控えは見えない', async () => {
    await new FileMrSnapshotRepository(cloneData('a')).save(id, makeSnapshot());

    expect((await new FileMrSnapshotRepository(cloneData('b')).findAll()).size).toBe(0);
  });

  it('置き場所を差し替えられる', async () => {
    const file = path.join(tmp, 'elsewhere', 'snapshots.json');
    const repository = new FileMrSnapshotRepository(cloneData('a'), { cacheFile: file });

    await repository.save(id, makeSnapshot());

    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('FileMrSnapshotRepository のマージ済みの PR の控え', () => {
  it('データ用ブランチの snapshots/<id>.json にコミットして push し、使い捨ての控えからは外す', async () => {
    const store = cloneData('a');
    const repository = new FileMrSnapshotRepository(store);

    await repository.save(id, makeSnapshot());
    await repository.save(id, merged());

    expect(originLog()).toEqual([
      'data: refresh-token のマージ済みの PR の控えを書く',
      'data: 始める',
    ]);
    expect(originFiles()).toContain(`${SNAPSHOTS_DIR}/refresh-token.json`);
    expect(JSON.parse(fs.readFileSync(cacheFile(store), 'utf-8'))).toEqual({});
    expect(await repository.findAll()).toEqual(new Map([[id, merged()]]));
  });

  it('ほかの clone からも読める', async () => {
    await new FileMrSnapshotRepository(cloneData('a')).save(id, merged());

    // 新しい clone は控えを持たずに始まる（クラウドのセッション）
    expect(await new FileMrSnapshotRepository(cloneData('b')).findAll()).toEqual(
      new Map([[id, merged()]])
    );
  });

  it('findMerged はデータ用ブランチのマージ済みだけを読み、使い捨ての控えは読まない', async () => {
    const store = cloneData('a');
    const repository = new FileMrSnapshotRepository(store);
    const open = 'open-card' as CardId;

    await repository.save(id, merged());
    await repository.save(open, makeSnapshot({ iid: 43 as MergeRequestIid }));

    expect(await repository.findMerged()).toEqual(new Map([[id, merged()]]));
    expect((await repository.findAll()).has(open)).toBe(true);
  });

  it('2 つの clone が同じ PR を書いても、コミットは 1 つ', async () => {
    const a = cloneData('a');
    const b = cloneData('b');

    await new FileMrSnapshotRepository(a).save(id, merged());
    // 項目の順が違っても、同じ中身なら同じファイルになる
    const reordered = merged();
    await new FileMrSnapshotRepository(b).save(id, {
      mr: Object.fromEntries(Object.entries(reordered.mr).reverse()) as MrSnapshot['mr'],
      fingerprint: reordered.fingerprint,
    });

    expect(originLog()).toEqual([
      'data: refresh-token のマージ済みの PR の控えを書く',
      'data: 始める',
    ]);
  });

  it('番号を付け替えて開いている PR を書くと、前のマージ済みの控えを消す', async () => {
    const repository = new FileMrSnapshotRepository(cloneData('a'));

    await repository.save(id, merged({ iid: 41 as MergeRequestIid }));
    await repository.save(id, makeSnapshot());

    expect(await repository.findAll()).toEqual(new Map([[id, makeSnapshot()]]));
    expect(originLog()[0]).toBe('data: refresh-token のマージ済みの PR の控えを消す');
    expect(originFiles()).not.toContain(`${SNAPSHOTS_DIR}/refresh-token.json`);
  });

  it('消すとデータ用ブランチからも消す', async () => {
    const repository = new FileMrSnapshotRepository(cloneData('a'));

    await repository.save(id, merged());
    await repository.delete(id);

    expect((await repository.findAll()).size).toBe(0);
    expect(originFiles()).toEqual(['ai-board-data.yaml']);
  });

  it('データ用ブランチに書けなくても例外を投げず、警告して使い捨ての控えにも残さない', async () => {
    // 投げるとポーラーの接続が error になり、ループが止まる。書けなかった控えは次のプロセスが引き直す
    const store = cloneData('a');
    git(store.dataDir, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    const repository = new FileMrSnapshotRepository(store);

    await repository.save(id, makeSnapshot());
    await expect(repository.save(id, merged())).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('マージ済みの PR の控えを書けませんでした')
    );
    // 古い開いている控えが残るので、次のプロセスはマージ済みとみなさずに引き直す
    expect((await repository.findAll()).get(id)?.mr.state).toBe('opened');
    expect(originLog()).toEqual(['data: 始める']);
  });
});

describe('FileMrSnapshotRepository の読めない控え', () => {
  it('形の合わない控えと、ID として不正な名前は黙って外す', async () => {
    const store = cloneData('a');
    const snapshots = path.join(store.dataDir, SNAPSHOTS_DIR);
    write(path.join(snapshots, 'broken-json.json'), '{');
    write(path.join(snapshots, 'missing-field.json'), JSON.stringify({ fingerprint: 'x' }));
    write(path.join(snapshots, 'Bad_Name.json'), JSON.stringify(merged()));
    write(path.join(snapshots, 'merged-one.json'), JSON.stringify(merged()));
    write(
      cacheFile(store),
      JSON.stringify({
        'missing-field': { fingerprint: 'x', mr: { iid: 1 } },
        'Bad Name': makeSnapshot(),
        [id]: makeSnapshot(),
      })
    );

    const found = await new FileMrSnapshotRepository(store).findAll();

    expect([...found.keys()].sort()).toEqual(['merged-one', id]);
  });

  it('readyAt を持たない古い控えは外す', async () => {
    // マージ済みの PR は二度と引き直さないので、ここで外さないと readyAt が入らないまま残る
    const store = cloneData('a');
    const { readyAt: _readyAt, ...old } = merged().mr;
    write(
      path.join(store.dataDir, SNAPSHOTS_DIR, 'refresh-token.json'),
      JSON.stringify({ fingerprint: '[1,"closed"]', mr: old })
    );

    expect((await new FileMrSnapshotRepository(store).findAll()).size).toBe(0);
  });

  it('壊れた使い捨ての控えは空とみなし、書き直せる', async () => {
    const store = cloneData('a');
    write(cacheFile(store), '{');
    const repository = new FileMrSnapshotRepository(store);

    expect((await repository.findAll()).size).toBe(0);

    await repository.save(id, makeSnapshot());

    expect(await repository.findAll()).toEqual(new Map([[id, makeSnapshot()]]));
  });
});

describe('parseMrSnapshot', () => {
  it('latestAiNoteAt を持たない古い控えは null で読む', () => {
    const { latestAiNoteAt: _dropped, ...old } = makeSnapshot().mr;

    const parsed = parseMrSnapshot({ fingerprint: '[1,"open"]', mr: old });

    expect(parsed?.mr.latestAiNoteAt).toBeNull();
    expect(parsed?.mr.noteCount).toBe(3);
  });
});
