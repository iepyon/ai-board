#!/usr/bin/env node
// ============================================================
// ArtifactData の PreToolUse の hook — ボードの置き場所へは送る箱の中身だけを書かせる
// ============================================================
//
// ボードの置き場所（`.ai-board/config.yaml` の `store.url` の Artifact の DB）への書き込みは、
// `ai-board` の CLI が検査を通して送る箱（`.ai-board/store/outbox/docs/`）に積んだものだけにする。
// Claude は人の権限で DB に書けるので、CLI を通さずに判断などを書く道をここで塞ぐ。
//
// - 読み出し（get / list / query / profiles）は通す
// - `batch` は、どのエントリも `op: "set"` で `if_version` を持たず、`file_path` が送る箱の `docs/` の下を指すときだけ通す
//   （置き場所の文書は書き換えず、改訂を新しい文書として作るため、版は使わない）
// - それ以外の書き込み（set / update / str_replace / delete と、条件に合わない batch）は拒む
// - ボードの置き場所でない Artifact と、`store.url` が未設定のときは何もしない
//
// 拒むときは終了コード 2 で理由を標準エラーに出す（Claude Code はツールの呼び出しを止め、理由を Claude に返す）。
// 入力が読めないなど hook 自身の不具合では、止めずに 0 で終える（hook の不具合で読み出しまで止めない）。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READ_ACTIONS = new Set(['get', 'list', 'query', 'profiles']);
const OUTBOX_DOCS = path.join('.ai-board', 'store', 'outbox', 'docs');

/** Artifact の URL から ID を取り出す。claude.ai/artifact/<id> と claude.ai/code/artifact/<id> の両方を読む */
export function artifactIdOf(url) {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)\/?$/.exec(url.trim());
  return match ? match[1] : null;
}

/** `.ai-board/config.yaml` の中身から `store.url` を読む（依存を持たないよう、行の形だけで読む） */
export function storeUrlOf(configYaml) {
  if (typeof configYaml !== 'string') return null;
  const lines = configYaml.split(/\r?\n/);
  let inStore = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inStore = /^store:\s*(#.*)?$/.test(line);
    if (!inStore) continue;
    const match = /^\s+url:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/.exec(line);
    if (match && match[1] !== 'null' && match[1] !== '~') return match[1];
  }
  return null;
}

/**
 * ツールの呼び出しを通すか決める。通すなら null、拒むなら理由の文を返す。
 *
 * `storeUrl` はボードの置き場所の URL（未設定なら null）、`projectDir` はリポジトリの根。
 * 送る箱は、どのワークツリーからもメインのチェックアウトの `.ai-board/store/` を使うので、
 * パスの中に `.ai-board/store/outbox/docs/` を含むかで見る（`..` で抜けるものは拒む）。
 */
export function decide(input, storeUrl) {
  const toolInput = input && typeof input === 'object' ? input.tool_input : null;
  if (!toolInput || typeof toolInput !== 'object') return null;

  const boardId = artifactIdOf(storeUrl);
  if (boardId === null || artifactIdOf(toolInput.url) !== boardId) return null;

  const action = toolInput.action;
  if (READ_ACTIONS.has(action)) return null;

  if (action !== 'batch') {
    return (
      `ボードの置き場所へ ArtifactData の ${String(action)} で直接書くことはできません。` +
      'ai-board の CLI で書き、ai-board store outbox --json の batch を送ってください（board-store のスキル）'
    );
  }

  const writes = Array.isArray(toolInput.writes) ? toolInput.writes : [];
  if (writes.length === 0) return 'batch の writes が空です';

  for (const [index, write] of writes.entries()) {
    const problem = problemOf(write);
    if (problem !== null) {
      return (
        `ボードの置き場所への batch の writes[${index}] は送れません（${problem}）。` +
        'ai-board store outbox --json が出した writes をそのまま渡してください'
      );
    }
  }
  return null;
}

function problemOf(write) {
  if (!write || typeof write !== 'object') return '形が違います';
  if (write.op !== 'set') return `op が ${String(write.op)} です`;
  if (write.if_version !== undefined) return 'if_version を付けています';
  if (write.data !== undefined) return 'data で中身を直に渡しています';
  if (typeof write.file_path !== 'string') return 'file_path がありません';
  const normalized = path.normalize(write.file_path);
  if (normalized.split(path.sep).includes('..')) return 'file_path に .. があります';
  if (
    !normalized.includes(`${path.sep}${OUTBOX_DOCS}${path.sep}`) &&
    !normalized.startsWith(`${OUTBOX_DOCS}${path.sep}`)
  ) {
    return 'file_path が送る箱の docs/ の下ではありません';
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return 0;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
  let configYaml = null;
  try {
    configYaml = readFileSync(path.join(projectDir, '.ai-board', 'config.yaml'), 'utf-8');
  } catch {
    return 0;
  }

  const reason = decide(input, storeUrlOf(configYaml));
  if (reason === null) return 0;
  process.stderr.write(`${reason}\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
