import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HARNESS_VERSIONS_FILE,
  parseHarnessVersion,
  readHarnessVersion,
} from '../harness-version.js';

describe('parseHarnessVersion', () => {
  it('先頭の ## v<番号> の見出しを今の版として読む', () => {
    const text = [
      '# 手順書の版',
      '',
      '## v3 — 2026-11-10',
      '',
      '- 何かを変えた',
      '',
      '## v2 — 2026-11-07',
    ].join('\n');
    expect(parseHarnessVersion(text)).toBe('v3');
  });

  it('版の見出しが無い・形が違えば null', () => {
    expect(parseHarnessVersion('# 手順書の版\n\n本文だけ')).toBeNull();
    expect(parseHarnessVersion('## version 1')).toBeNull();
    expect(parseHarnessVersion('## v0 — 2026-11-10')).toBeNull();
    expect(parseHarnessVersion('### v1')).toBeNull();
  });

  it('見出しの後ろに日付が無くても読む', () => {
    expect(parseHarnessVersion('## v12')).toBe('v12');
  });
});

describe('readHarnessVersion', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-harness-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('root の .claude/HARNESS_VERSIONS.md を読む', () => {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, HARNESS_VERSIONS_FILE), '## v1 — 2026-11-05\n');
    expect(readHarnessVersion(root)).toBe('v1');
  });

  it('ファイルが無ければ null', () => {
    expect(readHarnessVersion(root)).toBeNull();
  });
});
