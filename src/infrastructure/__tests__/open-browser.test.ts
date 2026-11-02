import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { browserCommand, openBrowser } from '../open-browser.js';

const URL = 'http://127.0.0.1:5673/?a=1&b=2';

describe('browserCommand', () => {
  it('darwin は open に URL を渡す', () => {
    expect(browserCommand('darwin', URL)).toEqual({ command: 'open', args: [URL] });
  });

  it('linux は xdg-open に URL を渡す', () => {
    expect(browserCommand('linux', URL)).toEqual({ command: 'xdg-open', args: [URL] });
  });

  it('win32 は cmd を介さず rundll32 の FileProtocolHandler に URL を渡す', () => {
    expect(browserCommand('win32', URL)).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', URL],
    });
  });
});

/** spawn の代わりに、error イベントを後から出せる子プロセスを返す */
function fakeChild(): ChildProcess & { unrefed: boolean } {
  const child = new EventEmitter() as ChildProcess & { unrefed: boolean };
  child.unrefed = false;
  child.unref = () => {
    child.unrefed = true;
  };
  return child;
}

describe('openBrowser', () => {
  it('OS のコマンドを引数の配列で起動し、待たずに切り離す', () => {
    const calls: [string, readonly string[]][] = [];
    const child = fakeChild();

    openBrowser(URL, {
      platform: 'win32',
      spawn: (command, args) => {
        calls.push([command, args]);
        return child;
      },
      warn: () => {},
    });

    expect(calls).toEqual([['rundll32', ['url.dll,FileProtocolHandler', URL]]]);
    expect(child.unrefed).toBe(true);
  });

  it('子プロセスの error イベント（ENOENT など）で落ちず、警告を 1 行出す', () => {
    const child = fakeChild();
    const warnings: string[] = [];

    openBrowser(URL, { platform: 'linux', spawn: () => child, warn: (m) => warnings.push(m) });
    // リスナーが無ければ、EventEmitter は error を例外として投げる
    child.emit('error', new Error('spawn xdg-open ENOENT'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('xdg-open');
    expect(warnings[0]).toContain(URL);
  });

  it('spawn が例外を投げても落ちず、警告を出す', () => {
    const warnings: string[] = [];

    openBrowser(URL, {
      platform: 'darwin',
      spawn: () => {
        throw new Error('EACCES');
      },
      warn: (m) => warnings.push(m),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EACCES');
  });
});
