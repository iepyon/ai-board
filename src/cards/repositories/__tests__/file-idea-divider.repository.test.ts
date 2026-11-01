import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileIdeaDividerRepository } from '../file-idea-divider.repository.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-file-divider-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function orderYaml(): string {
  return fs.readFileSync(path.join(dataDir, 'order.yaml'), 'utf-8');
}

describe('FileIdeaDividerRepository', () => {
  it('一度も置いていなければ null', async () => {
    expect(await new FileIdeaDividerRepository(dataDir).get()).toBe(null);
  });

  it('置いた値を読み、置き直すと 1 つの値のまま上書きする', async () => {
    const repository = new FileIdeaDividerRepository(dataDir);

    await repository.set(1500);
    await repository.set(2500.5);

    expect(await repository.get()).toBe(2500.5);
    expect(orderYaml()).toBe('divider: 2500.5\nranks: {}\n');
  });

  it('カードの rank は残したまま書き換える', async () => {
    fs.writeFileSync(path.join(dataDir, 'order.yaml'), 'divider: 1\nranks:\n  card-a: 500\n');

    await new FileIdeaDividerRepository(dataDir).set(2000);

    expect(orderYaml()).toBe('divider: 2000\nranks:\n  card-a: 500\n');
  });

  it('壊れた order.yaml は、読むときは null とみなし、書くときは書き戻さずに拒む', async () => {
    fs.writeFileSync(path.join(dataDir, 'order.yaml'), 'ranks: [\n');
    const repository = new FileIdeaDividerRepository(dataDir);

    expect(await repository.get()).toBe(null);
    await expect(repository.set(1000)).rejects.toMatchObject({
      reason: { type: 'MalformedOrderFile' },
    });
    expect(orderYaml()).toBe('ranks: [\n');
  });

  it('書き込みの後に onWrite を呼ぶ', async () => {
    const onWrite = vi.fn();

    await new FileIdeaDividerRepository(dataDir, onWrite).set(1);

    expect(onWrite).toHaveBeenCalledTimes(1);
  });
});
