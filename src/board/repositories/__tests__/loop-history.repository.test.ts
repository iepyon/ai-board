import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isErr } from '../../../shared/result.js';
import type { LoopStep } from '../../models/loop-step.js';
import {
  LOOP_COLLECTION,
  LOOP_VOCABULARY_IN_SYNC,
  createDocLoopHistoryRepository,
  loopFileName,
  parseLoopFileName,
  parseLoopStep,
  readLoopSteps,
  serializeLoopStep,
  writeLoopFinish,
  writeLoopStart,
  type LoopStartInput,
} from '../loop-history.repository.js';

/** `list` と `set` だけを持つ置き場所（書き込みの関数は transact の中から呼ばれる前提で、ここでは transact を省く） */
function makeStore() {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    list: (collection: string) =>
      collection !== LOOP_COLLECTION
        ? []
        : [...docs.keys()].sort().map((id) => ({ id, data: docs.get(id) ?? {} })),
    set: (_collection: string, id: string, data: Record<string, unknown>) => {
      docs.set(id, structuredClone(data));
    },
  };
}

let dataDir: ReturnType<typeof makeStore>;

beforeEach(() => {
  dataDir = makeStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const START: LoopStartInput = {
  loop: 'session-a',
  cardId: 'card-a',
  action: 'implement',
  step: 'task',
  agent: 'board-worker-card-a-1114',
  startedAt: '2026-11-02T11:14:06.000Z',
};

function loopFiles(): string[] {
  return [...dataDir.docs.keys()].map((id) => `${id}.json`).sort();
}

function readFile(name: string): unknown {
  return dataDir.docs.get(name.slice(0, -'.json'.length));
}

/** 文書を直に置く。JSON として読めない中身は、形の合わない文書として置く */
function writeRaw(name: string, content: string): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    data = { broken: content };
  }
  dataDir.docs.set(name.replace(/\.json$/, ''), data);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`失敗した: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('手と段の値の一覧', () => {
  it('次の一手の型と食い違わない（食い違えば型エラーになる）', () => {
    expect(LOOP_VOCABULARY_IN_SYNC).toBe(true);
  });
});

describe('ファイル名', () => {
  it('開始の時刻と識別子から作り、読んで戻せる', () => {
    const name = loopFileName('2026-11-02T11:14:06.000Z', 'session-a', new Set());
    expect(name).toBe('20261102T111406.000Z.session-a.json');
    expect(parseLoopFileName(name ?? '')).toEqual({
      at: '2026-11-02T11:14:06.000Z',
      tail: 'session-a',
    });
  });

  it('同じ名前があれば連番を付ける', () => {
    const taken = new Set([
      '20261102T111406.000Z.session-a.json',
      '20261102T111406.000Z.session-a-2.json',
    ]);
    expect(loopFileName('2026-11-02T11:14:06.000Z', 'session-a', taken)).toBe(
      '20261102T111406.000Z.session-a-3.json'
    );
  });

  it('時刻として読めなければ null', () => {
    expect(loopFileName('not a date', 'session-a', new Set())).toBeNull();
    expect(parseLoopFileName('20261302T111406.000Z.session-a.json')).toBeNull();
    expect(parseLoopFileName('20261102T111406.000Z.session-a.md')).toBeNull();
    expect(parseLoopFileName('x.json')).toBeNull();
  });
});

describe('中身', () => {
  it('書いて読み戻せる', () => {
    const step: LoopStep = {
      ...START,
      finishedAt: '2026-11-02T11:31:40.000Z',
      result: 'advanced',
    };
    expect(parseLoopStep(JSON.parse(serializeLoopStep(step)))).toEqual(step);
  });

  it('終了の時刻と結果の片方だけが埋まっていれば読まない', () => {
    expect(
      parseLoopStep({
        ...START,
        finishedAt: '2026-11-02T11:31:40.000Z',
        result: null,
      })
    ).toBeNull();
  });

  it('廃止した手（revise-impl / ready）の過去の記録も読める', () => {
    const base = {
      ...START,
      step: null,
      finishedAt: null,
      result: null,
    };
    expect(parseLoopStep({ ...base, action: 'revise-impl' })?.action).toBe('revise-impl');
    expect(parseLoopStep({ ...base, action: 'ready' })?.action).toBe('ready');
  });

  it('規定外の手・不正な識別子は読まない', () => {
    const base = { ...START, finishedAt: null, result: null };
    expect(parseLoopStep({ ...base, action: 'foo' })).toBeNull();
    expect(parseLoopStep({ ...base, loop: '../x' })).toBeNull();
  });

  it('以前の記録に残る手順書の版・トークン・時間は捨てて読む', () => {
    const old = {
      ...START,
      harness: 'v2',
      finishedAt: '2026-11-02T11:31:40.000Z',
      result: 'advanced',
      tokens: 412345,
      durationMs: 1054000,
    };
    expect(parseLoopStep(old)).toEqual({
      ...START,
      finishedAt: '2026-11-02T11:31:40.000Z',
      result: 'advanced',
    });
  });
});

describe('writeLoopStart', () => {
  it('終わっていない記録を作る', () => {
    const outcome = unwrap(writeLoopStart(dataDir, START));

    expect(outcome.interrupted).toEqual([]);
    expect(loopFiles()).toEqual(['20261102T111406.000Z.session-a.json']);
    expect(readFile('20261102T111406.000Z.session-a.json')).toEqual({
      loop: 'session-a',
      cardId: 'card-a',
      action: 'implement',
      step: 'task',
      agent: 'board-worker-card-a-1114',
      startedAt: '2026-11-02T11:14:06.000Z',
      finishedAt: null,
      result: null,
    });
  });

  it('同じループの終わっていない記録を interrupted で閉じてから作る。ほかのループの記録には触らない', () => {
    unwrap(writeLoopStart(dataDir, START));
    unwrap(
      writeLoopStart(dataDir, {
        ...START,
        loop: 'session-b',
        startedAt: '2026-11-02T11:15:00.000Z',
      })
    );

    const outcome = unwrap(
      writeLoopStart(dataDir, {
        ...START,
        action: 'plan',
        step: null,
        startedAt: '2026-11-02T11:20:00.000Z',
      })
    );

    expect(outcome.interrupted).toHaveLength(1);
    expect(readFile('20261102T111406.000Z.session-a.json')).toMatchObject({
      result: 'interrupted',
      finishedAt: '2026-11-02T11:20:00.000Z',
    });
    expect(readFile('20261102T111500.000Z.session-b.json')).toMatchObject({ result: null });
    expect(readFile('20261102T112000.000Z.session-a.json')).toMatchObject({
      action: 'plan',
      result: null,
    });
  });

  it('同じ時刻と識別子が重なれば連番のファイルにする', () => {
    unwrap(writeLoopStart(dataDir, START));
    unwrap(writeLoopStart(dataDir, START));

    expect(loopFiles()).toEqual([
      '20261102T111406.000Z.session-a-2.json',
      '20261102T111406.000Z.session-a.json',
    ]);
    // 連番のファイルも、識別子が `-` を含んでいても読める
    expect(readLoopSteps(dataDir)).toHaveLength(2);
  });

  it('時刻がファイル名にできなければ拒んで何も書かない', () => {
    const result = writeLoopStart(dataDir, { ...START, startedAt: 'nope' });
    expect(isErr(result) && result.error.type).toBe('InvalidLoopTime');
    expect(dataDir.docs.size).toBe(0);
  });
});

describe('writeLoopFinish', () => {
  const FINISH = {
    loop: 'session-a',
    cardId: 'card-a',
    result: 'advanced' as const,
    finishedAt: '2026-11-02T11:31:40.000Z',
  };

  it('そのループの終わっていない記録を埋める', () => {
    unwrap(writeLoopStart(dataDir, START));
    const finished = unwrap(writeLoopFinish(dataDir, FINISH));

    expect(finished).toMatchObject({ result: 'advanced' });
    expect(readFile('20261102T111406.000Z.session-a.json')).toMatchObject({
      finishedAt: '2026-11-02T11:31:40.000Z',
      result: 'advanced',
    });
  });

  it('終わった記録は書き換えない。2 度目の終了は終わっていない記録が無いので拒む', () => {
    unwrap(writeLoopStart(dataDir, START));
    unwrap(writeLoopFinish(dataDir, FINISH));
    const before = JSON.stringify(readFile('20261102T111406.000Z.session-a.json'));

    const again = writeLoopFinish(dataDir, { ...FINISH, result: 'stopped' });
    expect(isErr(again) && again.error.type).toBe('NoRunningLoopStep');

    // 開始も、終わった記録を interrupted で閉じ直さない
    unwrap(writeLoopStart(dataDir, { ...START, startedAt: '2026-11-02T12:00:00.000Z' }));
    expect(JSON.stringify(readFile('20261102T111406.000Z.session-a.json'))).toBe(before);
  });

  it('カードが食い違えば拒んで何も書かない', () => {
    unwrap(writeLoopStart(dataDir, START));
    const result = writeLoopFinish(dataDir, { ...FINISH, cardId: 'card-b' });

    expect(isErr(result) && result.error).toEqual({
      type: 'RunningLoopStepCardMismatch',
      loop: 'session-a',
      running: 'card-a',
      given: 'card-b',
    });
    expect(readFile('20261102T111406.000Z.session-a.json')).toMatchObject({ result: null });
  });

  it('ほかのループの終わっていない記録は埋めない', () => {
    unwrap(writeLoopStart(dataDir, START));
    const result = writeLoopFinish(dataDir, { ...FINISH, loop: 'session-b' });
    expect(isErr(result) && result.error.type).toBe('NoRunningLoopStep');
  });
});

describe('読み出し', () => {
  it('開始の時刻の順に返し、読めないファイルは警告して飛ばす', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    unwrap(writeLoopStart(dataDir, { ...START, loop: 'b', startedAt: '2026-11-02T12:00:00.000Z' }));
    unwrap(writeLoopStart(dataDir, { ...START, loop: 'a' }));
    writeRaw('20261102T130000.000Z.c.json', '{ not json');
    writeRaw('readme', '{"x": 1}');
    // ファイル名の時刻と中身の時刻が食い違う
    writeRaw(
      '20261102T140000.000Z.a.json',
      serializeLoopStep({
        ...START,
        loop: 'a',
        finishedAt: null,
        result: null,
      })
    );
    // ファイル名の識別子と中身の識別子が食い違う
    writeRaw(
      '20261102T111406.000Z.zzz.json',
      serializeLoopStep({
        ...START,
        loop: 'a',
        finishedAt: null,
        result: null,
      })
    );

    const steps = await createDocLoopHistoryRepository(dataDir).findAll();

    expect(steps.map((s) => s.loop)).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('loop の文書が無ければ空', () => {
    expect(readLoopSteps(dataDir)).toEqual([]);
  });
});
