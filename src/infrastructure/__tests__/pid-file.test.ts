import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describePidFileError, writePidFile } from '../pid-file.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-pid-file-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('writePidFile', () => {
  it('pid を 1 行で書く。親のディレクトリが無ければ作る', () => {
    const file = path.join(tmp, 'run', 'pid');

    expect(writePidFile(file, 4321).ok).toBe(true);

    expect(fs.readFileSync(file, 'utf-8')).toBe('4321\n');
  });

  it('既にあるファイルは上書きする', () => {
    const file = path.join(tmp, 'pid');
    fs.writeFileSync(file, '1\n');

    writePidFile(file, 99);

    expect(fs.readFileSync(file, 'utf-8')).toBe('99\n');
  });

  it('書けなければ例外を投げず、PidFileWriteFailed を返す', () => {
    // ディレクトリをファイルとして書こうとして失敗させる
    const result = writePidFile(tmp, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('PidFileWriteFailed');
      expect(result.error.file).toBe(tmp);
      expect(describePidFileError(result.error)).toContain('起動をやめます');
      expect(describePidFileError(result.error)).toContain(tmp);
    }
  });
});
