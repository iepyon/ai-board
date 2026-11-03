import { describe, it, expect } from 'vitest';
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

describe('openBrowser', () => {
  it('OS のコマンドを引数の配列で、切り離して起動する入口に渡す', () => {
    const calls: [string, readonly string[]][] = [];

    openBrowser(URL, {
      platform: 'win32',
      spawn: (command, args) => {
        calls.push([command, args]);
      },
      warn: () => {},
    });

    expect(calls).toEqual([['rundll32', ['url.dll,FileProtocolHandler', URL]]]);
  });

  it('起動の失敗（ENOENT など）が届いたら、落ちずに警告を 1 行出す', () => {
    const warnings: string[] = [];
    let onError: ((error: unknown) => void) | undefined;

    openBrowser(URL, {
      platform: 'linux',
      spawn: (_command, _args, handler) => {
        onError = handler;
      },
      warn: (m) => warnings.push(m),
    });
    onError?.(new Error('spawn xdg-open ENOENT'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('xdg-open');
    expect(warnings[0]).toContain('ENOENT');
    expect(warnings[0]).toContain(URL);
  });

  it('起動の入口が何も返さなければ、警告は出さない', () => {
    const warnings: string[] = [];

    openBrowser(URL, { platform: 'darwin', spawn: () => {}, warn: (m) => warnings.push(m) });

    expect(warnings).toEqual([]);
  });
});
