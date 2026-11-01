import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findLiveServer,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
  type ServerInfo,
} from '../server-info.js';

let dir: string;
let dataDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-server-info-'));
  dataDir = path.join(dir, 'data');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

function info(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return {
    url: 'http://127.0.0.1:5674',
    pid: 4242,
    dataDir,
    startedAt: '2026-10-31T00:00:00.000Z',
    ...overrides,
  };
}

const alive = (): boolean => true;
const dead = (): boolean => false;

describe('writeServerInfo / removeServerInfo', () => {
  it('データのワークツリーの親に書き、自分の pid のときだけ消す', async () => {
    writeServerInfo(info());
    expect(serverInfoPath(dataDir)).toBe(path.join(dir, 'server.json'));
    expect(JSON.parse(await fs.readFile(serverInfoPath(dataDir), 'utf-8'))).toEqual(info());

    removeServerInfo(dataDir, 9999);
    await expect(fs.access(serverInfoPath(dataDir))).resolves.toBeUndefined();

    removeServerInfo(dataDir, 4242);
    await expect(fs.access(serverInfoPath(dataDir))).rejects.toThrow();
  });

  it('ファイルが無くても消す処理は失敗しない', () => {
    expect(() => removeServerInfo(dataDir, 4242)).not.toThrow();
  });

  it('書けなくても例外を投げず警告する', () => {
    writeServerInfo(info({ dataDir: path.join(dir, 'missing', 'data') }));

    expect(console.warn).toHaveBeenCalled();
  });
});

describe('findLiveServer', () => {
  it('同じデータの生きているサーバの URL を返す', () => {
    writeServerInfo(info());

    expect(findLiveServer(dataDir, alive)).toEqual({ url: 'http://127.0.0.1:5674' });
  });

  it('ファイルが無ければ null', () => {
    expect(findLiveServer(dataDir, alive)).toBeNull();
  });

  it('形が違えば null', async () => {
    await fs.writeFile(serverInfoPath(dataDir), '{"url":1}', 'utf-8');
    expect(findLiveServer(dataDir, alive)).toBeNull();

    await fs.writeFile(serverInfoPath(dataDir), 'not json', 'utf-8');
    expect(findLiveServer(dataDir, alive)).toBeNull();
  });

  it('別のデータのサーバのものなら null', () => {
    writeServerInfo(info());
    // 同じディレクトリの別のデータを指す status から見た場合
    expect(findLiveServer(path.join(dir, 'other'), alive)).toBeNull();
  });

  it('相対パスや末尾の区切りがあっても同じデータとして照らし合わせる', () => {
    writeServerInfo(info());

    expect(findLiveServer(`${dataDir}${path.sep}`, alive)).toEqual({
      url: 'http://127.0.0.1:5674',
    });
    expect(findLiveServer(path.relative(process.cwd(), dataDir), alive)).toEqual({
      url: 'http://127.0.0.1:5674',
    });
  });

  it('dbPath で書かれた古い server.json は読まない', async () => {
    await fs.writeFile(
      serverInfoPath(dataDir),
      JSON.stringify({
        url: 'http://127.0.0.1:5674',
        pid: 4242,
        dbPath: path.join(dir, 'board.db'),
        startedAt: '2026-10-31T00:00:00.000Z',
      }),
      'utf-8'
    );

    expect(findLiveServer(dataDir, alive)).toBeNull();
  });

  it('プロセスが死んでいれば null（落ちたサーバの残骸）', () => {
    writeServerInfo(info());

    expect(findLiveServer(dataDir, dead)).toBeNull();
  });

  it('既定では実際のプロセスを確かめる', () => {
    writeServerInfo(info({ pid: process.pid }));

    expect(findLiveServer(dataDir)).toEqual({ url: 'http://127.0.0.1:5674' });
  });
});
