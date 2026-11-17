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

interface Outbox {
  docsDir: string;
  entries: Set<string>;
}

interface GuardModule {
  artifactIdOf(url: unknown): string | null;
  storeUrlOf(configYaml: unknown): string | null;
  decide(
    input: unknown,
    storeUrl: string | null,
    outbox: Outbox | null,
    realpath?: (file: string) => string | null
  ): string | null;
  mainCheckoutOf(projectDir: string): string;
}

const SCRIPT = fileURLToPath(new URL('../../scripts/artifact-data-guard.mjs', import.meta.url));

async function load(): Promise<GuardModule> {
  const specifier = new URL('../../scripts/artifact-data-guard.mjs', import.meta.url).href;
  return (await import(specifier)) as GuardModule;
}

const BOARD = 'https://claude.ai/artifact/BoardArtifact01';
const DOCS = '/home/u/repo/.ai-board/store/outbox/docs';
const OUTBOX_FILE = `${DOCS}/000001-1.json`;
const OUTBOX: Outbox = { docsDir: DOCS, entries: new Set(['log|a.1~000001|000001-1.json']) };
/** テストではパスをそのまま実体とみなす */
const identity = (file: string): string => path.resolve(file);

function call(toolInput: Record<string, unknown>): unknown {
  return { tool_name: 'ArtifactData', tool_input: { url: BOARD, ...toolInput } };
}

const GOOD = { op: 'set', collection: 'log', doc_id: 'a.1~000001', file_path: OUTBOX_FILE };

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
      expect(decide(call({ action, collection: 'cards' }), BOARD, OUTBOX, identity)).toBeNull();
    }
  });

  it('ボードの置き場所への set / update / delete は拒む', async () => {
    const { decide } = await load();
    for (const action of ['set', 'update', 'str_replace', 'delete']) {
      expect(
        decide(call({ action, collection: 'log', doc_id: 'x' }), BOARD, OUTBOX, identity)
      ).toContain(action);
    }
  });

  it('送る箱の束に載った、送る箱の docs/ の版なしの set だけの batch は通す', async () => {
    const { decide } = await load();
    expect(decide(call({ action: 'batch', writes: [GOOD] }), BOARD, OUTBOX, identity)).toBeNull();
  });

  it.each([
    ['送る箱の外', { ...GOOD, file_path: '/tmp/x.json' }],
    [
      'ほかのディレクトリの .ai-board/store/outbox/docs',
      { ...GOOD, file_path: '/tmp/x/.ai-board/store/outbox/docs/000001-1.json' },
    ],
    ['.. で抜ける', { ...GOOD, file_path: `${DOCS}/../../x.json` }],
    ['束に載っていない組', { ...GOOD, doc_id: 'a.1~000002' }],
    ['束に載っていないファイル', { ...GOOD, file_path: `${DOCS}/000009-1.json` }],
    ['中身を直に渡す', { op: 'set', collection: 'log', doc_id: 'a', data: { kind: 'approve' } }],
    ['版を付ける', { ...GOOD, if_version: 1 }],
    ['delete', { op: 'delete', collection: 'log', doc_id: 'a' }],
    ['update', { ...GOOD, op: 'update' }],
  ])('batch に %s のエントリがあれば拒む', async (_name, write) => {
    const { decide } = await load();
    expect(
      decide(call({ action: 'batch', writes: [GOOD, write] }), BOARD, OUTBOX, identity)
    ).toContain('writes[1]');
  });

  it('実体が送る箱の外にあるリンクは拒む', async () => {
    const { decide } = await load();
    const linked = (file: string): string => (file === OUTBOX_FILE ? '/tmp/elsewhere.json' : file);
    expect(decide(call({ action: 'batch', writes: [GOOD] }), BOARD, OUTBOX, linked)).toContain(
      'writes[0]'
    );
  });

  it('送る箱が無ければ書き込みの batch を拒む', async () => {
    const { decide } = await load();
    expect(decide(call({ action: 'batch', writes: [GOOD] }), BOARD, null, identity)).toContain(
      '送る箱がありません'
    );
  });

  it('リンクされたワークツリーからメインのチェックアウトを求める', async () => {
    const { mainCheckoutOf } = await load();
    const root = mkdtempSync(path.join(tmpdir(), 'ai-board-guard-main-'));
    try {
      const wt = path.join(root, 'main', '.claude', 'worktrees', 'x');
      mkdirSync(path.join(root, 'main', '.git', 'worktrees', 'x'), { recursive: true });
      mkdirSync(wt, { recursive: true });
      writeFileSync(
        path.join(wt, '.git'),
        `gitdir: ${path.join(root, 'main', '.git', 'worktrees', 'x')}\n`
      );
      expect(mainCheckoutOf(wt)).toBe(path.join(root, 'main'));
      expect(mainCheckoutOf(path.join(root, 'main'))).toBe(path.join(root, 'main'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ボードでない Artifact と、store.url が未設定のときは何もしない', async () => {
    const { decide } = await load();
    const write = call({ action: 'set', collection: 'x', doc_id: 'y' }) as {
      tool_input: Record<string, unknown>;
    };
    expect(
      decide(
        { tool_input: { ...write.tool_input, url: 'https://claude.ai/artifact/Other' } },
        BOARD,
        OUTBOX,
        identity
      )
    ).toBeNull();
    expect(decide(write, null, OUTBOX, identity)).toBeNull();
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

      const outbox = path.join(dir, '.ai-board', 'store', 'outbox');
      mkdirSync(path.join(outbox, 'docs'), { recursive: true });
      writeFileSync(path.join(outbox, 'docs', '000001-1.json'), '{}');
      writeFileSync(
        path.join(outbox, '000001.json'),
        JSON.stringify({
          label: 'x',
          writes: [{ collection: 'log', physicalId: 'a.1~000001', file: '000001-1.json' }],
        })
      );
      const write = {
        op: 'set',
        collection: 'log',
        doc_id: 'a.1~000001',
        file_path: path.join(outbox, 'docs', '000001-1.json'),
      };

      expect(run(call({ action: 'set', collection: 'log', doc_id: 'x', data: {} }))).toBe(2);
      expect(run(call({ action: 'list', collection: 'cards' }))).toBe(0);
      expect(run(call({ action: 'batch', writes: [write] }))).toBe(0);
      expect(run(call({ action: 'batch', writes: [{ ...write, doc_id: 'a.1~000002' }] }))).toBe(2);
    });

    it('config.yaml が無ければ止めない', () => {
      dir = mkdtempSync(path.join(tmpdir(), 'ai-board-guard-'));
      expect(run(call({ action: 'set', collection: 'log', doc_id: 'x', data: {} }))).toBe(0);
    });
  });
});
