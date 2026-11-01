import { describe, it, expect } from 'vitest';
import { resolveImplStep } from '../impl-step.js';

function active(...lines: string[]) {
  return { location: 'active' as const, text: lines.join('\n') };
}

describe('resolveImplStep', () => {
  describe('段の表', () => {
    it('plans/archive/ にあれば close', () => {
      expect(resolveImplStep({ location: 'archived' })).toBe('close');
    });

    it('未チェックのタスクがあれば task', () => {
      const plan = active('# 計画', '', '## タスク', '', '- [x] 1 つ目', '- [ ] 2 つ目');
      expect(resolveImplStep(plan)).toBe('task');
    });

    it('全部倒れていて ## AI レビュー 節が無ければ review', () => {
      const plan = active('# 計画', '', '## タスク', '', '- [x] 1 つ目', '- [x] 2 つ目');
      expect(resolveImplStep(plan)).toBe('review');
    });

    it('全部倒れていて ## AI レビュー 節があれば close', () => {
      const plan = active(
        '## タスク',
        '',
        '- [x] 1 つ目',
        '',
        '## AI レビュー',
        '',
        '- [x] 指摘を直す'
      );
      expect(resolveImplStep(plan)).toBe('close');
    });

    it('## AI レビュー 節の未チェックの指摘はタスクとして数え、task', () => {
      const plan = active(
        '## タスク',
        '',
        '- [x] 1 つ目',
        '',
        '## AI レビュー',
        '',
        '- [ ] 指摘を直す'
      );
      expect(resolveImplStep(plan)).toBe('task');
    });
  });

  describe('コードブロック', () => {
    it('コードブロックの中の ## AI レビュー は節と数えず、review', () => {
      const plan = active('## タスク', '', '- [x] 1 つ目', '', '```md', '## AI レビュー', '```');
      expect(resolveImplStep(plan)).toBe('review');
    });

    it('コードブロックが閉じた後の ## AI レビュー は節と数え、close', () => {
      const plan = active(
        '```md',
        '## AI レビュー',
        '```',
        '',
        '- [x] 1 つ目',
        '',
        '## AI レビュー',
        '',
        '- [x] 指摘'
      );
      expect(resolveImplStep(plan)).toBe('close');
    });

    it('コードブロックの中の未チェックの行もタスクとして数え、task（進捗バーと同じ）', () => {
      const plan = active('- [x] 1 つ目', '', '```md', '- [ ] 例', '```');
      expect(resolveImplStep(plan)).toBe('task');
    });

    it('行全体が見出しでなければ節と数えない', () => {
      const plan = active(
        '- [x] 1 つ目',
        '',
        '## AI レビューの方針',
        '',
        '`## AI レビュー` 節を足す'
      );
      expect(resolveImplStep(plan)).toBe('review');
    });

    it('見出しの行末の空白や CR は無視する', () => {
      const plan = {
        location: 'active' as const,
        text: '- [x] 1 つ目\r\n\r\n## AI レビュー  \r\n',
      };
      expect(resolveImplStep(plan)).toBe('close');
    });
  });

  describe('書き方の揺れ', () => {
    it('[X] は倒れたタスクと数える', () => {
      const plan = active('- [X] 1 つ目', '* [X] 2 つ目');
      expect(resolveImplStep(plan)).toBe('review');
    });

    it('詰めた書き方の未チェックも task', () => {
      expect(resolveImplStep(active('-[x] 1 つ目', '-[ ] 2 つ目'))).toBe('task');
    });

    it('詰めた書き方の倒れたタスクだけなら review', () => {
      expect(resolveImplStep(active('-[x] 1 つ目', '*[X] 2 つ目'))).toBe('review');
    });

    it('字下げされたサブタスクの未チェックも task', () => {
      expect(resolveImplStep(active('- [x] 1 つ目', '  - [ ] 1.1'))).toBe('task');
    });
  });

  describe('タスクが 0 件の計画', () => {
    it('## AI レビュー 節が無ければ review', () => {
      expect(resolveImplStep(active('# 計画', '', '## タスク', '', 'まだ無い'))).toBe('review');
    });

    it('## AI レビュー 節があれば close', () => {
      expect(resolveImplStep(active('# 計画', '', '## AI レビュー', '', '指摘なし'))).toBe('close');
    });

    it('空の本文は review', () => {
      expect(resolveImplStep(active(''))).toBe('review');
    });
  });
});
