import { describe, expect, it } from 'vitest';
import { mapCardWriteFailureToResponse } from '../card-error-mappings.js';

describe('mapCardWriteFailureToResponse', () => {
  it('DataBranchMissing は 500 で、ai-board init と board.db からの切り替えを案内する', () => {
    const result = mapCardWriteFailureToResponse({
      type: 'DataBranchMissing',
      dataDir: '/repo/.ai-board/data',
    });
    expect(result.status).toBe(500);
    expect(result.response.code).toBe('DATA_BRANCH_MISSING');
    expect(result.response.message).toContain('/repo/.ai-board/data');
    expect(result.response.message).toContain('ai-board init');
    expect(result.response.message).toContain('board.db からの切り替え');
  });
});
