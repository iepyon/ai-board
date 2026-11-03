import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `.claude/settings.json` の許可ルールの形を守る。
 *
 * Claude Code の照合そのものはテストできないので、ルールの `*` を任意の文字列（空も含む）とみなし、
 * コマンド全体と突き合わせる近似で確かめる。実際の挙動は動作確認で人が見る。
 */

const SETTINGS_PATH = fileURLToPath(new URL('../../.claude/settings.json', import.meta.url));

interface Permissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

function loadPermissions(): Permissions {
  const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as {
    permissions: Permissions;
  };
  return parsed.permissions;
}

function bashPatterns(rules: string[]): RegExp[] {
  return rules
    .filter((rule) => rule.startsWith('Bash(') && rule.endsWith(')'))
    .map((rule) => rule.slice('Bash('.length, -1))
    .map((body) => {
      const source = body
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${source}$`);
    });
}

function matches(rules: string[], command: string): boolean {
  return bashPatterns(rules).some((pattern) => pattern.test(command));
}

/** deny → ask → allow の順に評価した結果。どれにも当たらなければ確認が出る。 */
function decide(perms: Permissions, command: string): 'deny' | 'ask' | 'allow' | 'prompt' {
  if (matches(perms.deny, command)) return 'deny';
  if (matches(perms.ask, command)) return 'ask';
  if (matches(perms.allow, command)) return 'allow';
  return 'prompt';
}

describe('.claude/settings.json の許可ルール', () => {
  const perms = loadPermissions();

  it('allow / ask / deny が文字列の配列である', () => {
    for (const key of ['allow', 'ask', 'deny'] as const) {
      expect(Array.isArray(perms[key])).toBe(true);
      for (const rule of perms[key]) expect(typeof rule).toBe('string');
    }
  });

  it('deny にデータのワークツリーの編集・設定の編集・sqlite3 がある', () => {
    for (const rule of [
      'Edit(/.ai-board/data/**)',
      'Edit(**/.ai-board/data/**)',
      'Edit(/.claude/settings*.json)',
    ]) {
      expect(perms.deny).toContain(rule);
    }
  });

  it('Write(...) のルールを持たない（Claude Code はファイルの書き込みも Edit(...) で照合し、Write(...) は照合されず警告になる）', () => {
    const all = [...perms.allow, ...perms.ask, ...perms.deny];
    expect(all.filter((rule) => rule.startsWith('Write('))).toEqual([]);
  });

  it.each([
    'git push origin ai-board/data',
    'git -C /repo push origin HEAD:ai-board/data',
    'git push origin main',
    'git push -u origin main',
    'git push origin HEAD:main',
    'git push origin feature:main',
    'git push origin refs/heads/main',
    'git push origin main --force-with-lease',
    'git push --force-with-lease origin main',
    'git -C /repo push origin main',
    'git -C /repo push --force-with-lease origin main',
    'git push --force origin x',
    'git push origin x --force',
    'git push -f origin x',
    'git push origin x -f',
    'git push origin +x',
    'git -C /repo push --force origin x',
    'git -C /repo push -f origin x',
    'git -C /repo push origin +x',
    'git push origin --mirror',
    'git -C /repo push --mirror origin',
    'sqlite3 .ai-board/board.db',
    'sqlite3',
  ])('%s は deny に当たる', (command) => {
    expect(decide(perms, command)).toBe('deny');
  });

  it.each([
    'git push --force-with-lease origin loop-permissions',
    'git -C /repo/.claude/worktrees/x push --force-with-lease origin x',
  ])('%s は deny に当たらず allow に当たる', (command) => {
    expect(matches(perms.deny, command)).toBe(false);
    expect(decide(perms, command)).toBe('allow');
  });

  it('allow は auto モードの分類器が既定で止める操作だけを持つ', () => {
    expect(perms.allow).toEqual([
      'Bash(git push --force-with-lease origin *)',
      'Bash(git -C * push --force-with-lease origin *)',
      'Bash(git -C */.claude/worktrees/* checkout -- .)',
      'Bash(git -C */.claude/worktrees/* clean -fd)',
    ]);
  });

  it.each([
    'git -C /repo/.claude/worktrees/x checkout -- .',
    'git -C /repo/.claude/worktrees/x clean -fd',
  ])('%s は確認なしに走る', (command) => {
    expect(decide(perms, command)).toBe('allow');
  });

  it.each([
    'git reset --hard',
    'git -C /repo reset --hard origin/main',
    'git branch -D x',
    'git -C /repo branch -d x',
    'git worktree remove /repo/.claude/worktrees/x',
    'node /repo/dist/cli.js migrate --empty',
    'node dist/cli.js migrate',
  ])('%s は毎回確かめる', (command) => {
    expect(decide(perms, command)).toBe('ask');
  });

  it.each([
    'git push',
    'git -C /repo push',
    'node -e "1"',
    'curl http://127.0.0.1:5673/api/cards',
    'gh pr merge 1',
    'git checkout -- .',
    'git -C /repo checkout -- .',
    'git -C "" clean -fd',
    'git clean -fd',
    'git -C /repo clean -fd',
  ])('%s は allow に当たらない', (command) => {
    expect(decide(perms, command)).not.toBe('allow');
  });

  it('allow に広すぎるルールと migrate が無い', () => {
    const broad = [
      'Bash',
      'Bash(*)',
      'Bash(git *)',
      'Bash(git push)',
      'Bash(git push *)',
      'Bash(node *)',
      'Bash(gh *)',
      'Bash(curl *)',
      'Bash(node -e *)',
    ];
    for (const rule of broad) expect(perms.allow).not.toContain(rule);
    expect(perms.allow.filter((rule) => rule.includes('migrate'))).toEqual([]);
  });

  it('allow と deny に同じルールが無い', () => {
    expect(perms.allow.filter((rule) => perms.deny.includes(rule))).toEqual([]);
  });
});
