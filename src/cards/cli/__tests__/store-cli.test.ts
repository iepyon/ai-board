import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialDocuments, STORE_VERSION } from '../../../infrastructure/document-store.js';
import type { BackedDocumentStore } from '../../../infrastructure/backed-document-store.js';
import { createStoreFixture, type StoreFixture } from '../../../__tests__/store-fixture.js';
import {
  isStoreCommand,
  runStoreCli,
  STORE_USAGE,
  type StoreCliDependencies,
} from '../store-cli.js';

let fixture: StoreFixture;
let store: BackedDocumentStore;
let stdout: string;
let stderr: string;
let seedCalls: string[];

beforeEach(() => {
  fixture = createStoreFixture();
  store = fixture.open();
  stdout = '';
  stderr = '';
  seedCalls = [];
});

afterEach(() => {
  fixture.remove();
});

/** `cli-main.ts` の組み立てと同じ依存。置き場所は一時のディレクトリ */
function deps(): StoreCliDependencies {
  return {
    initialize: () => store.initialize(initialDocuments()),
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

describe('runStoreCli', () => {
  it('引数が無い・--help なら使い方を出して 0', async () => {
    expect(await run([])).toBe(0);
    expect(await run(['init', '--help'])).toBe(0);
    expect(stderr).toContain(STORE_USAGE);
  });

  it('消したコマンドは不明なコマンドとして 1', async () => {
    for (const command of ['pull', 'outbox', 'ack', 'discard', 'import']) {
      expect(isStoreCommand(command)).toBe(false);
      expect(await run([command])).toBe(1);
    }
    expect(stderr).toContain('不明なコマンドです: outbox');
  });

  describe('init', () => {
    it('空の置き場所に形の版を書き、2 度目は拒む', async () => {
      expect(await run(['init'])).toBe(0);
      expect(stdout).toContain('置き場所を始めました');
      expect(fixture.writeLabels()).toEqual(['置き場所を始める']);
      expect(fs.readFileSync(path.join(fixture.storeDir, 'board', 'meta.json'), 'utf-8')).toContain(
        `"version": ${STORE_VERSION}`
      );

      expect(await run(['init'])).toBe(1);
      expect(stderr).toContain('既に始まっています');
    });
  });

  describe('seed', () => {
    it('既定は seedDir、--from で別のディレクトリを渡す', async () => {
      expect(await run(['seed'])).toBe(0);
      expect(await run(['seed', '--from', 'other'])).toBe(0);
      expect(seedCalls).toEqual(['/repo/.ai-board/seed', 'other']);
    });

    it('--from に値が無ければ 1', async () => {
      expect(await run(['seed', '--from'])).toBe(1);
      expect(seedCalls).toEqual([]);
    });
  });
});
