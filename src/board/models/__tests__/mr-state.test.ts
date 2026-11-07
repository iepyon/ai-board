import { describe, it, expect } from 'vitest';
import { forgeTrusted, isForgeUnset, type ForgeConnection } from '../mr-state.js';

const UNSET: ForgeConnection = { status: 'disabled', kind: null, reason: null };
const UNAVAILABLE: ForgeConnection = { status: 'disabled', kind: 'github', reason: 'gh が無い' };
const ERROR: ForgeConnection = { status: 'error', kind: 'github', message: 'HTTP 502' };
const CONNECTED: ForgeConnection = { status: 'connected', kind: 'github' };

describe('isForgeUnset', () => {
  it('kind が null の disabled（github: が無い）だけを未設定とする', () => {
    expect(isForgeUnset(UNSET)).toBe(true);
    expect(isForgeUnset(UNAVAILABLE)).toBe(false);
    expect(isForgeUnset(ERROR)).toBe(false);
    expect(isForgeUnset(CONNECTED)).toBe(false);
  });
});

describe('forgeTrusted', () => {
  it('接続済みと未設定は信じ、使えない・エラーは信じない', () => {
    expect(forgeTrusted(CONNECTED)).toBe(true);
    expect(forgeTrusted(UNSET)).toBe(true);
    expect(forgeTrusted(UNAVAILABLE)).toBe(false);
    expect(forgeTrusted(ERROR)).toBe(false);
  });
});
