import * as fs from 'node:fs';
import * as path from 'node:path';
import { SNAPSHOTS_DIR } from '../board/repositories/file-pr-snapshot.repository.js';
import {
  CARD_FILE,
  CARDS_DIR,
  DATA_VERSION,
  DATA_VERSION_FILE,
  serializeDataVersion,
} from '../cards/repositories/card-files.js';

// ============================================================
// データ用ブランチの形の移行
// ============================================================

/**
 * 形の版を上げたときの、前の版からの書き換え。
 *
 * - 1 → 2: カードの `card.md` の frontmatter の `mr` を `pr` に、
 *   マージ済みの PR の控え（`snapshots/<id>.json`）の `mr` を `pr`、その中の `iid` を `number` に改める
 *
 * 取り直した後のワークツリーのファイルを書き換えるだけで、コミットと push はしない。
 * 読み出しでは取り直すたびに書き換え直し、書き込みでは `DataStore` がこれを 1 つのコミットにしてから `op` を走らせる。
 * 何度走らせても同じ結果になる。
 */
export const DATA_MIGRATION_MESSAGE = `data: 形の版を ${DATA_VERSION} に上げる`;

/** `dataDir` の形を `from` の版から今の版へ書き換える。今の版なら何もしない */
export function migrateData(dataDir: string, from: number): void {
  if (from >= DATA_VERSION) return;

  if (from < 2) {
    renameCardPrField(dataDir);
    renameSnapshotFields(dataDir);
  }

  fs.writeFileSync(path.join(dataDir, DATA_VERSION_FILE), serializeDataVersion());
}

/** `card.md` の先頭の frontmatter の `mr:` の行を `pr:` に改める。本文には触れない */
function renameCardPrField(dataDir: string): void {
  for (const file of listFiles(path.join(dataDir, CARDS_DIR), (dir) => path.join(dir, CARD_FILE))) {
    const raw = fs.readFileSync(file, 'utf-8');
    const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(raw);
    if (match === null) continue;

    const frontmatter = match[0].replace(/^mr:/m, 'pr:');
    if (frontmatter !== match[0]) {
      fs.writeFileSync(file, frontmatter + raw.slice(match[0].length));
    }
  }
}

/** 控えの `mr` を `pr` に、その中の `iid` を `number` に改める。項目の順は保つ。読めない控えは触らない */
function renameSnapshotFields(dataDir: string): void {
  const dir = path.join(dataDir, SNAPSHOTS_DIR);
  if (!fs.existsSync(dir)) return;

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;

    const file = path.join(dir, name);
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!isRecord(json) || !isRecord(json['mr'])) continue;

    const renamed = renameKey(json, 'mr', 'pr', renameKey(json['mr'], 'iid', 'number'));
    fs.writeFileSync(file, `${JSON.stringify(renamed, null, 2)}\n`);
  }
}

function renameKey(
  record: Record<string, unknown>,
  from: string,
  to: string,
  value: unknown = record[from]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, current]) => (key === from ? [to, value] : [key, current]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `root` の下の各ディレクトリについて `pick` が返すファイルのうち、あるものを返す */
function listFiles(root: string, pick: (dir: string) => string): string[] {
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => pick(path.join(root, entry.name)))
    .filter((file) => fs.existsSync(file));
}
