import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactMirrorStore } from '../../../infrastructure/artifact-mirror-store.js';
import { STORE_VERSION } from '../../../infrastructure/document-store.js';
import { LOOP_COLLECTION, readLoopSteps } from '../../repositories/loop-history.repository.js';
import { parseFlags, runLoopCli, type LoopCliDependencies } from '../loop-cli.js';

// ============================================================
// 一時ディレクトリの写しと送る箱（Artifact の DB の実装）で確かめる
// ============================================================

let tmp: string;
let storeDir: string;
let stdout: string;
let stderr: string;
let now: Date;

/** 呼び出しごとに新しく組む（別のプロセスとして走らせるのと同じ） */
function openStore(): ArtifactMirrorStore {
  return new ArtifactMirrorStore(storeDir);
}

/** 送る箱の束の名前（古い順） */
function outboxLabels(): string[] {
  return openStore()
    .outbox()
    .map((batch) => batch.label);
}

/** 送る箱が作る文書の ID（古い順） */
function outboxDocs(): string[] {
  return openStore()
    .outbox()
    .flatMap((batch) => batch.writes.map((write) => `${write.collection}/${write.doc_id}`));
}

/** カードは `card-a` だけがあることにする。カードのリポジトリの書き込みの口は渡さない */
function deps(): LoopCliDependencies {
  return {
    store: openStore(),
    cardExists: (id) => Promise.resolve(id === 'card-a'),
  };
}

async function run(...argv: string[]): Promise<number> {
  return runLoopCli(argv, deps(), {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    now: () => now,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-loop-cli-'));
  storeDir = path.join(tmp, 'store');
  const meta = path.join(storeDir, 'mirror', 'board');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'meta~000001.json'), JSON.stringify({ version: STORE_VERSION }));

  stdout = '';
  stderr = '';
  now = new Date('2026-11-02T11:14:06.000Z');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const START = [
  'start',
  '--loop',
  'session-a',
  '--card',
  'card-a',
  '--action',
  'implement',
  '--step',
  'task',
  '--agent',
  'board-worker-card-a-1114',
];

const FINISH = ['finish', '--loop', 'session-a', '--card', 'card-a', '--result', 'advanced'];

describe('start と finish', () => {
  it('開始と終了をそれぞれ 1 束にして送る箱に積む。loop だけを書く', async () => {
    expect(await run(...START)).toBe(0);
    now = new Date('2026-11-02T11:15:41.000Z');
    expect(await run(...FINISH)).toBe(0);

    expect(outboxLabels()).toEqual([
      'loop: start card-a implement',
      'loop: finish card-a implement',
    ]);
    // 終了は同じ記録の次の改訂として積む（置き場所の文書は書き換えない）
    expect(outboxDocs()).toEqual([
      `${LOOP_COLLECTION}/20261102T111406.000Z.session-a~000001`,
      `${LOOP_COLLECTION}/20261102T111406.000Z.session-a~000002`,
    ]);
    expect(readLoopSteps(openStore())).toEqual([
      {
        loop: 'session-a',
        cardId: 'card-a',
        action: 'implement',
        step: 'task',
        agent: 'board-worker-card-a-1114',
        startedAt: '2026-11-02T11:14:06.000Z',
        finishedAt: '2026-11-02T11:15:41.000Z',
        result: 'advanced',
      },
    ]);
    expect(stdout).toBe(
      'session-a card-a implement（task）\nsession-a card-a implement（task） → advanced\n'
    );
    expect(stderr).toBe('');
  });

  it('同じループで start を続けると、前の記録を interrupted で閉じ、知らせる', async () => {
    expect(await run(...START)).toBe(0);
    now = new Date('2026-11-02T11:20:00.000Z');
    expect(
      await run('start', '--loop', 'session-a', '--card', 'card-a', '--action', 'revise-plan')
    ).toBe(0);

    expect(readLoopSteps(openStore()).map((s) => s.result)).toEqual(['interrupted', null]);
    expect(stderr).toContain('途切れた');
    expect(outboxLabels().at(-1)).toBe('loop: start card-a revise-plan');
  });

  it.each(['revise-impl', 'ready'])(
    'start は廃止した手（%s）を受け付けず、何も書かない',
    async (action) => {
      expect(
        await run('start', '--loop', 'session-a', '--card', 'card-a', '--action', action)
      ).toBe(1);
      expect(stderr).toContain('--action には plan / revise-plan / implement');
      expect(readLoopSteps(openStore())).toEqual([]);
    }
  );
});

describe('拒否（何も書かない）', () => {
  async function expectRefused(argv: string[], message: string): Promise<void> {
    const before = outboxLabels();
    const steps = JSON.stringify(readLoopSteps(openStore()));
    expect(await run(...argv)).toBe(1);
    expect(stderr).toContain(message);
    expect(outboxLabels()).toEqual(before);
    expect(JSON.stringify(readLoopSteps(openStore()))).toBe(steps);
  }

  it('存在しないカード', async () => {
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'nope', '--action', 'plan'],
      'カードが見つかりません: nope'
    );
  });

  it('不正な手・段・識別子', async () => {
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'card-a', '--action', 'foo'],
      '--action には'
    );
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'card-a', '--action', 'implement', '--step', 'x'],
      '--step には'
    );
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'card-a', '--action', 'plan', '--step', 'task'],
      '--action implement のときだけ'
    );
    await expectRefused(
      ['start', '--loop', '../x', '--card', 'card-a', '--action', 'plan'],
      '--loop には'
    );
    await expectRefused(['start', '--card', 'card-a', '--action', 'plan'], '--loop には');
  });

  it('不正な結果・知らないオプション', async () => {
    await run(...START);
    await expectRefused(
      ['finish', '--loop', 'session-a', '--card', 'card-a', '--result', 'interrupted'],
      '--result には'
    );
    await expectRefused(
      [
        'finish',
        '--loop',
        'session-a',
        '--card',
        'card-a',
        '--result',
        'advanced',
        '--tokens',
        '1',
      ],
      '不明なオプションです: --tokens'
    );
  });

  it('終わっていない記録が無い', async () => {
    await expectRefused(FINISH, '終わっていない記録がありません');
    await run(...START);
    stderr = '';
    await run(...FINISH);
    await expectRefused(FINISH, '終わっていない記録がありません');
  });

  it('--card が食い違う', async () => {
    await run(...START);
    await expectRefused(
      ['finish', '--loop', 'session-a', '--card', 'card-b', '--result', 'advanced'],
      'card-a のものです'
    );
  });
});

describe('使い方', () => {
  it('引数なしと --help は使い方を出して 0、知らないコマンドは 1', async () => {
    expect(await run()).toBe(0);
    expect(await run('--help')).toBe(0);
    expect(await run('delete')).toBe(1);
    expect(stderr).toContain('使い方: ai-board loop');
  });

  it('知らないフラグ・位置引数・重複・値の無いフラグを拒む', () => {
    expect(parseFlags(['--x', '1'], ['--loop'])).toBe('不明なオプションです: --x');
    expect(parseFlags(['card-a'], ['--loop'])).toBe('余分な引数です: card-a');
    expect(parseFlags(['--loop', 'a', '--loop', 'b'], ['--loop'])).toBe(
      '--loop が 2 回指定されています'
    );
    expect(parseFlags(['--loop'], ['--loop'])).toBe('--loop には値を指定してください');
  });
});
