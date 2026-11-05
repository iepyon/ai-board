import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeConfigDir,
  countSessionTokens,
  findSessionLogs,
  readSessionTokens,
} from '../session-usage.js';

const FROM = '2026-11-05T01:00:00.000Z';
const TO = '2026-11-05T01:10:00.000Z';

function assistant(id: string, timestamp: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', timestamp, message: { id, usage } });
}

const USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 1000,
  output_tokens: 30,
};

describe('countSessionTokens', () => {
  it('窓の中の assistant のメッセージの 4 つの値を足す。同じ id は 1 回だけ数える', () => {
    const lines = [
      assistant('m1', '2026-11-05T01:01:00.000Z', USAGE),
      assistant('m1', '2026-11-05T01:01:01.000Z', USAGE),
      assistant('m2', '2026-11-05T01:09:59.000Z', { output_tokens: 5 }),
    ];
    expect(countSessionTokens(lines, FROM, TO)).toBe(1132 + 5);
  });

  it('窓の外・assistant 以外・読めない行・usage の無い行は数えない', () => {
    const lines = [
      assistant('before', '2026-11-05T00:59:59.000Z', USAGE),
      assistant('after', '2026-11-05T01:10:01.000Z', USAGE),
      JSON.stringify({ type: 'user', timestamp: '2026-11-05T01:02:00.000Z', message: { id: 'u' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-05T01:02:00.000Z',
        message: { id: 'x' },
      }),
      '{ 壊れた行',
      '',
      assistant('edge', FROM, { output_tokens: 1 }),
      assistant('edge2', TO, { output_tokens: 2 }),
    ];
    expect(countSessionTokens(lines, FROM, TO)).toBe(3);
  });

  it('数えるメッセージが無い・窓が読めなければ null', () => {
    expect(countSessionTokens([], FROM, TO)).toBeNull();
    expect(countSessionTokens([assistant('m', FROM, USAGE)], 'いつか', TO)).toBeNull();
  });
});

describe('会話の記録のファイル', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-usage-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(file: string, lines: readonly string[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
  }

  it('セッションの本体とサブエージェントの記録を合わせて数える', () => {
    const project = path.join(dir, 'projects', '-home-user-repo');
    write(path.join(project, 'sess-1.jsonl'), [assistant('a', '2026-11-05T01:01:00.000Z', USAGE)]);
    write(path.join(project, 'sess-1', 'subagents', 'agent-x.jsonl'), [
      assistant('b', '2026-11-05T01:02:00.000Z', { output_tokens: 7 }),
    ]);
    write(path.join(project, 'sess-2.jsonl'), [assistant('c', '2026-11-05T01:03:00.000Z', USAGE)]);

    expect(findSessionLogs(dir, 'sess-1')).toHaveLength(2);
    expect(readSessionTokens('sess-1', FROM, TO, dir)).toBe(1132 + 7);
  });

  it('記録が見つからなければ null', () => {
    expect(findSessionLogs(dir, 'sess-1')).toEqual([]);
    expect(readSessionTokens('sess-1', FROM, TO, dir)).toBeNull();
  });

  it('CLAUDE_CONFIG_DIR があればそれを、無ければ ~/.claude を見る', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
    expect(claudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
  });
});
