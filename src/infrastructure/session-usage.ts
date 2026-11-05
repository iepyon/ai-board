import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================
// 1 手のトークン — Claude Code の会話の記録から数える
// ============================================================

/**
 * Claude Code の会話の記録（`<設定のディレクトリ>/projects/<作業ディレクトリ>/<セッション ID>.jsonl`）と、
 * その下のサブエージェントの記録（`<セッション ID>/subagents/*.jsonl`）から、1 手の窓のトークンを数える。
 *
 * 記録の形は Claude Code の内部のもので、変われば数えられなくなる。そのときは null を返し、
 * 1 手の記録のトークンは今どおり「—」になる。記録は見るためのもので、ループは止めない（ADR 0014）。
 */

/** assistant のメッセージ 1 つの usage のうち、足す値 */
const USAGE_FIELDS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
] as const;

/**
 * 会話の記録の行から、`from` 以上 `to` 以下の時刻の assistant のメッセージのトークンを足す。
 *
 * - 同じ `message.id` は 1 回だけ数える（1 つのメッセージが内容ごとに複数の行に分かれて書かれるため）
 * - 足すのは入力・キャッシュの書き込み・キャッシュの読み出し・出力の 4 つの和（使った量の総和）
 * - 読めない行と、形の合わない行は飛ばす。数えるメッセージが 1 つも無ければ null
 */
export function countSessionTokens(
  lines: Iterable<string>,
  from: string,
  to: string
): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const seen = new Set<string>();
  let total = 0;

  for (const line of lines) {
    const entry = parseLine(line);
    if (entry === null || seen.has(entry.id)) continue;
    if (entry.at < start || entry.at > end) continue;

    seen.add(entry.id);
    total += entry.tokens;
  }

  return seen.size === 0 ? null : total;
}

interface UsageEntry {
  readonly id: string;
  readonly at: number;
  readonly tokens: number;
}

function parseLine(line: string): UsageEntry | null {
  // 記録の大半は道具の結果などの行で、assistant の語を含まない行は JSON として読むまでもない
  if (!line.includes('"assistant"')) return null;

  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(json) || json['type'] !== 'assistant') return null;

  const message = json['message'];
  const timestamp = json['timestamp'];
  if (!isRecord(message) || typeof timestamp !== 'string') return null;

  const id = message['id'];
  const usage = message['usage'];
  const at = Date.parse(timestamp);
  if (typeof id !== 'string' || !isRecord(usage) || Number.isNaN(at)) return null;

  const tokens = USAGE_FIELDS.reduce((sum, field) => {
    const value = usage[field];
    return sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);

  return { id, at, tokens };
}

/** ファイルを 1 つずつ読んで行を出す。全部のファイルの行を 1 つの配列に溜めない */
function* linesOf(files: readonly string[]): Generator<string> {
  for (const file of files) {
    yield* fs.readFileSync(file, 'utf-8').split('\n');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Claude Code の設定のディレクトリ。`CLAUDE_CONFIG_DIR` があればそれ、無ければ `~/.claude` */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  return configured !== undefined && configured !== ''
    ? configured
    : path.join(os.homedir(), '.claude');
}

/** セッションの会話の記録のファイル（本体とサブエージェント）。見つからなければ空 */
export function findSessionLogs(configDir: string, sessionId: string): string[] {
  const projects = path.join(configDir, 'projects');
  const files: string[] = [];

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const base = path.join(projects, dir.name);
    const main = path.join(base, `${sessionId}.jsonl`);
    if (fs.existsSync(main)) files.push(main);

    const subagents = path.join(base, sessionId, 'subagents');
    try {
      for (const name of fs.readdirSync(subagents)) {
        if (name.endsWith('.jsonl')) files.push(path.join(subagents, name));
      }
    } catch {
      // サブエージェントを立てていないセッションには無い
    }
  }

  return files;
}

/**
 * セッションの `from`〜`to` のトークン。会話の記録が見つからない・読めない・数えるメッセージが無ければ null。
 * 例外は投げない（1 手の記録の終了を失敗させない）。
 */
export function readSessionTokens(
  sessionId: string,
  from: string,
  to: string,
  configDir: string = claudeConfigDir()
): number | null {
  try {
    return countSessionTokens(linesOf(findSessionLogs(configDir, sessionId)), from, to);
  } catch {
    return null;
  }
}
