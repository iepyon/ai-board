import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/artifact-data-guard.mjs`（ArtifactData の PreToolUse の hook）を確かめる。
 * 純関数は import して確かめ、終了コードは node で走らせて確かめる。
 */

interface GuardModule {
  artifactIdOf(url: unknown): string | null;
  storeUrlOf(configYaml: unknown): string | null;
  decide(input: unknown, storeUrl: string | null): string | null;
}

const SCRIPT = fileURLToPath(new URL('../../scripts/artifact-data-guard.mjs', import.meta.url));

async function load(): Promise<GuardModule> {
  const specifier = new URL('../../scripts/artifact-data-guard.mjs', import.meta.url).href;
  return (await import(specifier)) as GuardModule;
}

const BOARD = 'https://claude.ai/artifact/BoardArtifact01';
const OUTBOX = '/home/u/repo/.ai-board/store/outbox/docs/000001-1.json';

function call(toolInput: Record<string, unknown>): unknown {
  return { tool_name: 'ArtifactData', tool_input: { url: BOARD, ...toolInput } };
}

describe('artifact-data-guard', () => {
  it('store.url を config.yaml の store の節から読む', async () => {
    const { storeUrlOf } = await load();
    expect(storeUrlOf(`github:\n  repository: 'a/b'\nstore:\n  url: '${BOARD}'\n`)).toBe(BOARD);
    expect(storeUrlOf('store:\n  url: null\n')).toBeNull();
    expect(storeUrlOf(`other:\n  url: '${BOARD}'\n`)).toBeNull();
  });

  it('artifact の URL から ID を読む', async () => {
    const { artifactIdOf } = await load();
    expect(artifactIdOf(BOARD)).toBe('BoardArtifact01');
    expect(artifactIdOf('https://claude.ai/code/artifact/BoardArtifact01')).toBe('BoardArtifact01');
    expect(artifactIdOf('https://example.com/artifact/x')).toBeNull();
  });

  it('読み出しは通す', async () => {
    const { decide } = await load();
    for (const action of ['get', 'list', 'query', 'profiles']) {
      expect(decide(call({ action, collection: 'cards' }), BOARD)).toBeNull();
    }
  });

  it('ボードの置き場所への set / update / delete は拒む', async () => {
    const { decide } = await load();
    for (const action of ['set', 'update', 'str_replace', 'delete']) {
      expect(decide(call({ action, collection: 'log', doc_id: 'x' }), BOARD)).toContain(action);
    }
  });

  it('送る箱の docs/ を指す版なしの set だけの batch は通す', async () => {
    const { decide } = await load();
    const writes = [{ op: 'set', collection: 'log', doc_id: 'a.1~000001', file_path: OUTBOX }];
    expect(decide(call({ action: 'batch', writes }), BOARD)).toBeNull();
  });

  it.each([
    ['送る箱の外', { op: 'set', collection: 'log', doc_id: 'a', file_path: '/tmp/x.json' }],
    [
      '.. で抜ける',
      {
        op: 'set',
        collection: 'log',
        doc_id: 'a',
        file_path: '/r/.ai-board/store/outbox/docs/../../x.json',
      },
    ],
    ['中身を直に渡す', { op: 'set', collection: 'log', doc_id: 'a', data: { kind: 'approve' } }],
    ['版を付ける', { op: 'set', collection: 'log', doc_id: 'a', file_path: OUTBOX, if_version: 1 }],
    ['delete', { op: 'delete', collection: 'log', doc_id: 'a' }],
    ['update', { op: 'update', collection: 'log', doc_id: 'a', file_path: OUTBOX }],
  ])('batch に %s のエントリがあれば拒む', async (_name, write) => {
    const { decide } = await load();
    const ok = { op: 'set', collection: 'log', doc_id: 'b', file_path: OUTBOX };
    expect(decide(call({ action: 'batch', writes: [ok, write] }), BOARD)).toContain('writes[1]');
  });

  it('ボードでない Artifact と、store.url が未設定のときは何もしない', async () => {
    const { decide } = await load();
    const write = call({ action: 'set', collection: 'x', doc_id: 'y' }) as {
      tool_input: Record<string, unknown>;
    };
    expect(
      decide(
        { tool_input: { ...write.tool_input, url: 'https://claude.ai/artifact/Other' } },
        BOARD
      )
    ).toBeNull();
    expect(decide(write, null)).toBeNull();
  });

  describe('node で走らせる', () => {
    let dir: string;

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function run(input: unknown): number {
      try {
        execFileSync('node', [SCRIPT], {
          input: JSON.stringify(input),
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    }

    it('拒むときは終了コード 2、通すときは 0', () => {
      dir = mkdtempSync(path.join(tmpdir(), 'ai-board-guard-'));
      mkdirSync(path.join(dir, '.ai-board'));
      writeFileSync(path.join(dir, '.ai-board', 'config.yaml'), `store:\n  url: '${BOARD}'\n`);

      expect(run(call({ action: 'set', collection: 'log', doc_id: 'x', data: {} }))).toBe(2);
      expect(run(call({ action: 'list', collection: 'cards' }))).toBe(0);
    });

    it('config.yaml が無ければ止めない', () => {
      dir = mkdtempSync(path.join(tmpdir(), 'ai-board-guard-'));
      expect(run(call({ action: 'set', collection: 'log', doc_id: 'x', data: {} }))).toBe(0);
    });
  });
});
