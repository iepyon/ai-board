import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { describeDataStoreError } from '../data-store-messages.js';

describe('describeDataStoreError', () => {
  it('DataStoreLocalAhead は、件数と、上げる・捨てる・手元モードで続ける手順を書く', () => {
    const dataDir = path.join('/repo', '.ai-board', 'data');

    const message = describeDataStoreError({ type: 'DataStoreLocalAhead', dataDir, count: 2 });

    expect(message).toContain('commit が 2 件');
    expect(message).toContain(`git -C ${dataDir} push origin HEAD:ai-board/data`);
    expect(message).toContain(`git -C ${dataDir} reset --hard origin/ai-board/data`);
    expect(message).toContain(
      `${path.join('/repo', '.ai-board', 'data-mode.yaml')} に mode: local`
    );
  });

  it('UnsupportedDataVersion は、新しい版なら ai-board を新しくし、古い版なら移す処理のある版を案内する', () => {
    const newer = describeDataStoreError({
      type: 'UnsupportedDataVersion',
      found: 3,
      supported: 2,
    });
    const older = describeDataStoreError({
      type: 'UnsupportedDataVersion',
      found: 1,
      supported: 2,
    });

    expect(newer).toContain('より新しい');
    expect(newer).toContain('ai-board を新しくして');
    expect(older).toContain('より古い');
    expect(older).toContain('a15da2b');
  });
});
