import { describe, it, expect } from 'vitest';
import { buildBoardLog, BOARD_LOG_LIMIT, type LogCard } from '../board-log.js';

type Step = LogCard['loopSteps'][number];
type Review = LogCard['reviews'][number];

function step(startedAt: string, overrides: Partial<Step> = {}): Step {
  return {
    action: 'implement',
    step: 'task',
    startedAt,
    result: 'advanced',
    tokens: 1000,
    durationMs: 60_000,
    ...overrides,
  };
}

function review(at: string, overrides: Partial<Review> = {}): Review {
  return { at, gate: 'plan', kind: '提出', reason: '', ...overrides };
}

function card(id: string, overrides: Partial<LogCard> = {}): LogCard {
  return { id, title: `${id} のタイトル`, reviews: [], loopSteps: [], ...overrides };
}

describe('buildBoardLog', () => {
  it('記録が無ければ空', () => {
    expect(buildBoardLog([])).toEqual({ entries: [], omitted: 0 });
  });

  it('全カードのループの手と判断を、新しい順の 1 本にする', () => {
    const log = buildBoardLog([
      card('a', {
        loopSteps: [step('2026-10-20T01:00:00.000Z')],
        reviews: [review('2026-10-20T03:00:00.000Z')],
      }),
      card('b', {
        loopSteps: [step('2026-10-20T02:00:00.000Z', { action: 'plan', step: null })],
        reviews: [review('2026-10-20T00:00:00.000Z', { kind: '否決', gate: 'verify' })],
      }),
    ]);

    expect(log.omitted).toBe(0);
    expect(log.entries.map((entry) => [entry.at.slice(11, 13), entry.cardId, entry.kind])).toEqual([
      ['03', 'a', 'review'],
      ['02', 'b', 'loop'],
      ['01', 'a', 'loop'],
      ['00', 'b', 'review'],
    ]);
    expect(log.entries[0]).toMatchObject({ cardTitle: 'a のタイトル' });
  });

  it('同じ時刻はカード ID の順、ループの手を判断より先にする', () => {
    const at = '2026-10-20T00:00:00.000Z';
    const log = buildBoardLog([
      card('b', { reviews: [review(at)], loopSteps: [step(at)] }),
      card('a', { reviews: [review(at)] }),
    ]);

    expect(log.entries.map((entry) => `${entry.cardId}:${entry.kind}`)).toEqual([
      'a:review',
      'b:loop',
      'b:review',
    ]);
  });

  it('読めない時刻の記録は最後に回す', () => {
    const log = buildBoardLog([
      card('a', {
        reviews: [review('壊れた時刻'), review('2026-10-20T00:00:00.000Z')],
      }),
    ]);

    expect(log.entries.map((entry) => entry.at)).toEqual([
      '2026-10-20T00:00:00.000Z',
      '壊れた時刻',
    ]);
  });

  it('件数を超えた古い記録は省き、省いた件数を返す', () => {
    const steps = [0, 1, 2, 3, 4].map((hour) => step(`2026-10-20T0${hour}:00:00.000Z`));
    const log = buildBoardLog([card('a', { loopSteps: steps })], 2);

    expect(log.entries.map((entry) => entry.at.slice(11, 13))).toEqual(['04', '03']);
    expect(log.omitted).toBe(3);
  });

  it('既定の件数は BOARD_LOG_LIMIT', () => {
    const steps = Array.from({ length: BOARD_LOG_LIMIT + 5 }, (_, i) =>
      step(new Date(Date.UTC(2026, 9, 20, 0, i)).toISOString())
    );
    const log = buildBoardLog([card('a', { loopSteps: steps })]);

    expect(log.entries).toHaveLength(BOARD_LOG_LIMIT);
    expect(log.omitted).toBe(5);
  });

  it('終わっていない手と、判断の理由をそのまま運ぶ', () => {
    const running = step('2026-10-20T00:00:00.000Z', {
      result: null,
      tokens: null,
      durationMs: null,
    });
    const rejected = review('2026-10-19T00:00:00.000Z', { kind: '否決', reason: '直して' });
    const log = buildBoardLog([card('a', { loopSteps: [running], reviews: [rejected] })]);

    expect(log.entries[0]).toEqual({
      kind: 'loop',
      at: running.startedAt,
      cardId: 'a',
      cardTitle: 'a のタイトル',
      step: running,
    });
    expect(log.entries[1]).toEqual({
      kind: 'review',
      at: rejected.at,
      cardId: 'a',
      cardTitle: 'a のタイトル',
      review: rejected,
    });
  });
});
