import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

/**
 * `.claude/hooks/guard-human-api.mjs`（サブエージェントの中から人の判断を書く口を拒む PreToolUse の hook）の形を守る。
 *
 * Claude Code が hook を発火させるところはテストできないので、スクリプトを `node` で起こし、
 * hook の入力に近い JSON を標準入力に渡して出力を見る。実際の発火は動作確認で人が見る。
 */

const HOOK_PATH = fileURLToPath(
  new URL('../../.claude/hooks/guard-human-api.mjs', import.meta.url)
);
const AGENTS = ['board-planner', 'board-worker', 'board-reviewer'] as const;

function agentPath(name: string): string {
  return fileURLToPath(new URL(`../../.claude/agents/${name}.md`, import.meta.url));
}

interface HookResult {
  status: number | null;
  stdout: string;
}

function runHook(stdin: string): HookResult {
  const result = spawnSync(process.execPath, [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout };
}

function inSubagent(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 's',
    hook_event_name: 'PreToolUse',
    agent_id: 'agent-1',
    agent_type: 'board-worker',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

function bash(command: string): string {
  return inSubagent('Bash', { command });
}

function expectDenied(result: HookResult): void {
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
    'サブエージェントからは使えない'
  );
}

function expectAllowed(result: HookResult): void {
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
}

describe('guard-human-api.mjs — サブエージェントの中の Bash', () => {
  it.each([
    [
      'レビューの追記（POST）',
      `curl -sS -X POST http://127.0.0.1:5673/api/cards/x/reviews -H 'content-type: application/json' -d '{"gate":"plan","kind":"approve"}'`,
    ],
    [
      'frontmatter の更新（PATCH）',
      `curl -sS -XPATCH http://127.0.0.1:5673/api/cards/x --data '{"startedAt":null}'`,
    ],
    ['並べ替え', `curl -sS -X POST http://127.0.0.1:5673/api/cards/x/move -d '{}'`],
    ['区切り線の移動', `curl -sS -X POST http://127.0.0.1:5673/api/idea-divider/move -d '{}'`],
    [
      'node -e の fetch',
      `node -e "fetch('http://127.0.0.1:5673/api/cards/x/reviews',{method:'POST',body:'{}'})"`,
    ],
    ['大文字の道', `curl -sS -X POST http://127.0.0.1:5673/API/Cards/x/reviews`],
  ])('%s は拒む', (_label, command) => {
    expectDenied(runHook(bash(command)));
  });

  it.each([
    ['カードの提出', `node /m/dist/cli.js card submit x --gate verify --reason "r" --root /m`],
    ['status', `node /m/dist/cli.js status --json --only server --root /m`],
    ['ボードの読み取り', `curl -sS http://127.0.0.1:5673/api/board`],
    ['health', `curl -sS http://127.0.0.1:5673/api/health`],
  ])('%s は通す', (_label, command) => {
    expectAllowed(runHook(bash(command)));
  });
});

describe('guard-human-api.mjs — サブエージェントの中の Skill', () => {
  it.each(['board-decide', 'plugin:board-decide', '/board-decide'])('%s は拒む', (skill) => {
    expectDenied(runHook(inSubagent('Skill', { skill })));
  });

  it.each(['board-loop', 'code-review', 'board-decider'])('%s は通す', (skill) => {
    expectAllowed(runHook(inSubagent('Skill', { skill })));
  });
});

describe('guard-human-api.mjs — 拒まない入力', () => {
  it('agent_id の無い入力（本筋のセッション）は、人の API を叩くコマンドでも通す', () => {
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'curl -sS -X POST http://127.0.0.1:5673/api/cards/x/reviews' },
    });
    expectAllowed(runHook(input));
  });

  it('agent_id の無い Skill の board-decide も通す', () => {
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      agent_type: 'board-loop',
      tool_name: 'Skill',
      tool_input: { skill: 'board-decide' },
    });
    expectAllowed(runHook(input));
  });

  it.each(['{not json', '', 'null', '[]', '{"agent_id":"a","tool_name":"Bash"}'])(
    '読めない・想定外の入力 %j は通す',
    (stdin) => {
      expectAllowed(runHook(stdin));
    }
  );

  it('Bash と Skill 以外のツールは通す', () => {
    expectAllowed(runHook(inSubagent('Read', { file_path: '/x/api/cards.ts' })));
  });
});

describe('サブエージェントの定義の frontmatter', () => {
  const hookOf = (name: string): unknown =>
    matter(readFileSync(agentPath(name), 'utf-8')).data.hooks;

  it.each(AGENTS)('%s に PreToolUse の hook が書かれている', (name) => {
    expect(hookOf(name)).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash|Skill',
          hooks: [
            {
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-human-api.mjs"',
            },
          ],
        },
      ],
    });
  });

  it('3 つの定義の hook が同じである', () => {
    const [first, ...rest] = AGENTS.map(hookOf);
    for (const other of rest) expect(other).toEqual(first);
  });
});
