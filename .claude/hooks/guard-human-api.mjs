#!/usr/bin/env node
// サブエージェント（board-planner / board-worker / board-reviewer）の中から、
// 人の判断を書く口（人の API と board-decide のスキル）を呼ぶツールの呼び出しを拒む PreToolUse の hook。
//
// - hook の入力に agent_id が載るのはサブエージェントの中で発火したときだけなので、無ければ何もしない（本筋は止めない）
// - Bash はコマンドの文字列に人の API の道（/api/cards・/api/idea-divider）を含めば拒む。メソッドでは分けない。
//   API を叩かず道を含むだけのコマンド（grep、コミットの文面、ヒアドキュメント）も巻き添えで拒み、理由でそれを伝える
// - Skill は board-decide（<plugin>:board-decide も）を拒む
// - 読めない入力・想定外の形は拒まずに通す（hook の不具合で全部のツールを止めないため）
//
// 文字列の照合なので、わざと崩した呼び出しまでは止めない（docs/adr/0007-board-decide.md）。

const HUMAN_API_PATTERN = /\/api\/(cards|idea-divider)/i;
const DECIDE_SKILL_PATTERN = /^(?:[^:\s]+:)?board-decide$/i;
const REASON =
  '人の判断を書く口（人の API の /api/cards・/api/idea-divider と board-decide のスキル）はサブエージェントからは使えない。' +
  '人に頼むことは報告に書く。カードは ai-board card の CLI で読み書きする。' +
  '道の文字列を含むだけのコマンドも拒む。検索は Grep のツールを使い、コミットや本文の文面は道を書かずに言い換える。';

/** 拒むなら理由を、通すなら null を返す。 */
export function decide(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (input.tool_name === 'Bash') {
    const command = toolInput.command;
    return typeof command === 'string' && HUMAN_API_PATTERN.test(command) ? REASON : null;
  }
  if (input.tool_name === 'Skill') {
    const skill = toolInput.skill;
    return typeof skill === 'string' && DECIDE_SKILL_PATTERN.test(skill.trim().replace(/^\//, ''))
      ? REASON
      : null;
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const reason = decide(input);
  if (reason === null) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n'
  );
}

main().catch(() => {
  // 想定外の失敗でも通す
});
