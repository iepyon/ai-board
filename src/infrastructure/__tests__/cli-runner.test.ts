import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCliRunner,
  parseJson,
  describeCliError,
  isNotFound,
  spawnDetached,
} from '../cli-runner.js';

const runner = createCliRunner({ timeoutMs: 5_000 });

describe('createCliRunner', () => {
  it('stdout をそのまま返す', async () => {
    const result = await runner.run('/bin/echo', ['hello']);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trim()).toBe('hello');
  });

  it('シェルの特殊文字を含む引数をコマンドとして解釈しない', async () => {
    const marker = path.join(os.tmpdir(), `ai-board-cli-runner-${process.pid}.marker`);
    await fs.rm(marker, { force: true });

    // shell を介していれば marker が作られ、出力も分断される
    const injected = `feat/x; touch ${marker}`;
    const result = await runner.run('/bin/echo', [injected]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trim()).toBe(injected);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('コマンド置換も展開しない', async () => {
    const result = await runner.run('/bin/echo', ['$(whoami)']);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trim()).toBe('$(whoami)');
  });

  it('CLI が無ければ NotInstalled を返す', async () => {
    const result = await runner.run('ai-board-no-such-command', ['--version']);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('NotInstalled');
  });

  it('終了コードが非 0 なら Failed を返す', async () => {
    const result = await runner.run('/bin/sh', ['-c', 'exit 3']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('Failed');
      if (result.error.type === 'Failed') expect(result.error.message).toContain('3');
    }
  });

  it('失敗の説明に stderr の中身を載せない', async () => {
    const result = await runner.run('/bin/sh', ['-c', 'echo glpat-secret 1>&2; exit 1']);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('glpat-secret');
  });
});

describe('parseJson', () => {
  it('JSON を読む', () => {
    const result = parseJson<{ a: number }>('gh', '{"a":1}\n');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.a).toBe(1);
  });

  it('空出力は InvalidJson にする', () => {
    const result = parseJson('gh', '  \n');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('InvalidJson');
  });

  it('不正な JSON は例外ではなく InvalidJson にする', () => {
    const result = parseJson('gh', 'not json');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('InvalidJson');
  });
});

describe('describeCliError', () => {
  it('CLI 不在と実行失敗で文言が分かれる', () => {
    expect(describeCliError({ type: 'NotInstalled', command: 'gh' })).toContain('見つからない');
    expect(
      describeCliError({ type: 'Failed', command: 'gh', message: '終了コード 1 で失敗した' })
    ).toContain('終了コード 1');
  });
});

describe('HTTP ステータスの取り出し', () => {
  it('stderr の (HTTP 404) から 404 を取り出し、それ以外の文言は捨てる', async () => {
    const result = await runner.run('/bin/sh', [
      '-c',
      'echo "gh: Not Found (HTTP 404) token=glpat-secret" 1>&2; exit 1',
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.type === 'Failed') {
      expect(result.error.httpStatus).toBe(404);
      expect(JSON.stringify(result.error)).not.toContain('glpat-secret');
    }
  });

  it('ステータスが書かれていなければ null にする', async () => {
    const result = await runner.run('/bin/sh', ['-c', 'echo boom 1>&2; exit 1']);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.type === 'Failed') {
      expect(result.error.httpStatus).toBeNull();
    }
  });
});

describe('isNotFound', () => {
  it('404 だけを「存在しない」と見なす', () => {
    expect(isNotFound({ type: 'Failed', command: 'gh', message: '', httpStatus: 404 })).toBe(true);
    expect(isNotFound({ type: 'Failed', command: 'gh', message: '', httpStatus: 500 })).toBe(false);
    expect(isNotFound({ type: 'NotInstalled', command: 'gh' })).toBe(false);
  });
});

describe('spawnDetached', () => {
  /** ファイルができるまで待つ（切り離した子プロセスの終わりは待てないため） */
  async function waitForFile(file: string, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (content !== '') return content;
      } catch {
        // まだ無い
      }
      if (Date.now() > deadline) throw new Error(`${file} が作られなかった`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('コマンドを引数の配列で起動する。シェルの特殊文字は解釈しない', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-spawn-detached-'));
    const out = path.join(dir, 'out');
    const marker = path.join(dir, 'marker');
    const injected = `x; touch ${marker}`;
    const errors: unknown[] = [];

    try {
      spawnDetached(
        process.execPath,
        ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', out, injected],
        (error) => errors.push(error)
      );

      expect(await waitForFile(out)).toBe(injected);
      expect(errors).toEqual([]);
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('コマンドが無ければ、落ちずに onError に渡す', async () => {
    const error = await new Promise<unknown>((resolve) => {
      spawnDetached('ai-board-no-such-command', ['x'], resolve);
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});
