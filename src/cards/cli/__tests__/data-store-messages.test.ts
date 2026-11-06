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
});
