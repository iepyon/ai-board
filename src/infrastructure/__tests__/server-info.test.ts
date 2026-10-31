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
let dbPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-server-info-'));
  dbPath = path.join(dir, 'board.db');
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
    dbPath,
    startedAt: '2026-10-31T00:00:00.000Z',
    ...overrides,
  };
}

const alive = (): boolean => true;
const dead = (): boolean => false;

describe('writeServerInfo / removeServerInfo', () => {
  it('DB の隣に書き、自分の pid のときだけ消す', async () => {
    writeServerInfo(info());
    expect(serverInfoPath(dbPath)).toBe(path.join(dir, 'server.json'));
    expect(JSON.parse(await fs.readFile(serverInfoPath(dbPath), 'utf-8'))).toEqual(info());

    removeServerInfo(dbPath, 9999);
    await expect(fs.access(serverInfoPath(dbPath))).resolves.toBeUndefined();

    removeServerInfo(dbPath, 4242);
    await expect(fs.access(serverInfoPath(dbPath))).rejects.toThrow();
  });

  it('ファイルが無くても消す処理は失敗しない', () => {
    expect(() => removeServerInfo(dbPath, 4242)).not.toThrow();
  });

  it('書けなくても例外を投げず警告する', () => {
    writeServerInfo(info({ dbPath: path.join(dir, 'missing', 'board.db') }));

    expect(console.warn).toHaveBeenCalled();
  });
});

describe('findLiveServer', () => {
  it('同じ DB の生きているサーバの URL を返す', () => {
    writeServerInfo(info());

    expect(findLiveServer(dbPath, alive)).toEqual({ url: 'http://127.0.0.1:5674' });
  });

  it('ファイルが無ければ null', () => {
    expect(findLiveServer(dbPath, alive)).toBeNull();
  });

  it('形が違えば null', async () => {
    await fs.writeFile(serverInfoPath(dbPath), '{"url":1}', 'utf-8');
    expect(findLiveServer(dbPath, alive)).toBeNull();

    await fs.writeFile(serverInfoPath(dbPath), 'not json', 'utf-8');
    expect(findLiveServer(dbPath, alive)).toBeNull();
  });

  it('別の DB のサーバのものなら null', () => {
    writeServerInfo(info());
    // 同じディレクトリの別の DB を指す status から見た場合
    expect(findLiveServer(path.join(dir, 'other.db'), alive)).toBeNull();
  });

  it('プロセスが死んでいれば null（落ちたサーバの残骸）', () => {
    writeServerInfo(info());

    expect(findLiveServer(dbPath, dead)).toBeNull();
  });

  it('既定では実際のプロセスを確かめる', () => {
    writeServerInfo(info({ pid: process.pid }));

    expect(findLiveServer(dbPath)).toEqual({ url: 'http://127.0.0.1:5674' });
  });
});
