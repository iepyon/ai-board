import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateData } from '../data-migration.js';

let dataDir: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dataDir, file)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), content);
}

function read(file: string): string {
  return fs.readFileSync(path.join(dataDir, file), 'utf-8');
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-data-migration-'));
  write('ai-board-data.yaml', 'version: 1\n');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('migrateData 1 → 2', () => {
  it('card.md の frontmatter の mr を pr に改め、本文には触れない', () => {
    write('cards/a/card.md', '---\nid: a\nbranch: feat/a\nmr: 42\n---\n\nmr: 本文の行\n');
    write('cards/b/card.md', '---\nid: b\nmr: null\n---\n');

    migrateData(dataDir, 1);

    expect(read('cards/a/card.md')).toBe(
      '---\nid: a\nbranch: feat/a\npr: 42\n---\n\nmr: 本文の行\n'
    );
    expect(read('cards/b/card.md')).toBe('---\nid: b\npr: null\n---\n');
    expect(read('ai-board-data.yaml')).toBe('version: 2\n');
  });

  it('控えの mr を pr に、iid を number に、項目の順を保って改める', () => {
    write(
      'snapshots/a.json',
      `${JSON.stringify({ fingerprint: 'f', mr: { forge: 'github', iid: 7, state: 'merged' } }, null, 2)}\n`
    );

    migrateData(dataDir, 1);

    expect(read('snapshots/a.json')).toBe(
      `${JSON.stringify({ fingerprint: 'f', pr: { forge: 'github', number: 7, state: 'merged' } }, null, 2)}\n`
    );
  });

  it('読めない控えには触らない', () => {
    write('snapshots/broken.json', '{ not json');

    migrateData(dataDir, 1);

    expect(read('snapshots/broken.json')).toBe('{ not json');
  });

  it('今の版なら何もしない', () => {
    write('ai-board-data.yaml', 'version: 2\n');
    write('cards/a/card.md', '---\nid: a\nmr: 42\n---\n');

    migrateData(dataDir, 2);

    expect(read('cards/a/card.md')).toBe('---\nid: a\nmr: 42\n---\n');
  });
});
