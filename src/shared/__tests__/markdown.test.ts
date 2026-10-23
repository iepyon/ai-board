import { describe, it, expect } from 'vitest';
import { parseBlocks, parseInline, type Block, type ListBlock, type Span } from '../markdown.js';

const lines = (...values: string[]): string => values.join('\n');

function list(ordered: boolean, ...items: [string[], ListBlock[]?][]): ListBlock {
  return {
    type: 'list',
    ordered,
    items: items.map(([itemLines, children]) => ({ lines: itemLines, children: children ?? [] })),
  };
}

describe('parseBlocks', () => {
  it('空の本文は空の並びを返す', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('\n\n  \n')).toEqual([]);
  });

  describe('見出し', () => {
    it('# の数を深さとして読む', () => {
      expect(parseBlocks(lines('# 題', '## アイデア', '###### 深い'))).toEqual<Block[]>([
        { type: 'heading', level: 1, text: '題' },
        { type: 'heading', level: 2, text: 'アイデア' },
        { type: 'heading', level: 6, text: '深い' },
      ]);
    });

    it('末尾の閉じる # を外す', () => {
      expect(parseBlocks('## 背景 ##')).toEqual([{ type: 'heading', level: 2, text: '背景' }]);
    });

    it('# の後に空白が無ければ見出しにしない', () => {
      expect(parseBlocks('#タグ')).toEqual([{ type: 'paragraph', lines: ['#タグ'] }]);
    });

    it('# が 7 つ以上なら見出しにしない', () => {
      expect(parseBlocks('####### 七')).toEqual([{ type: 'paragraph', lines: ['####### 七'] }]);
    });

    it('レビューのエントリの見出しを読む', () => {
      expect(parseBlocks('### 2026-10-23T07:23:44.372Z plan 承認')).toEqual([
        { type: 'heading', level: 3, text: '2026-10-23T07:23:44.372Z plan 承認' },
      ]);
    });
  });

  describe('段落', () => {
    it('改行を行のまま持つ', () => {
      expect(parseBlocks(lines('一文目。', '二文目。'))).toEqual([
        { type: 'paragraph', lines: ['一文目。', '二文目。'] },
      ]);
    });

    it('空行で段落を分ける', () => {
      expect(parseBlocks(lines('一つ目。', '', '二つ目。'))).toEqual([
        { type: 'paragraph', lines: ['一つ目。'] },
        { type: 'paragraph', lines: ['二つ目。'] },
      ]);
    });

    it('見出し・箇条書き・表・コードの始まりで段落を終える', () => {
      expect(parseBlocks(lines('文。', '## 見出し', '文。', '- 項目', '文。'))).toEqual<Block[]>([
        { type: 'paragraph', lines: ['文。'] },
        { type: 'heading', level: 2, text: '見出し' },
        { type: 'paragraph', lines: ['文。'] },
        list(false, [['項目', '文。']]),
      ]);

      expect(parseBlocks(lines('文。', '| a |', '文。', '```', 'x', '```'))).toEqual<Block[]>([
        { type: 'paragraph', lines: ['文。'] },
        { type: 'rows', lines: ['| a |'] },
        { type: 'paragraph', lines: ['文。'] },
        { type: 'code', info: null, text: 'x' },
      ]);
    });

    it('行頭と行末の空白を落とす', () => {
      expect(parseBlocks('   字下げ  ')).toEqual([{ type: 'paragraph', lines: ['字下げ'] }]);
    });

    it('CRLF の改行も読む', () => {
      expect(parseBlocks('## 題\r\n一文目。\r\n二文目。')).toEqual<Block[]>([
        { type: 'heading', level: 2, text: '題' },
        { type: 'paragraph', lines: ['一文目。', '二文目。'] },
      ]);
    });

    it('知らない記法は文字のまま残す', () => {
      expect(parseBlocks(lines('---', '> 引用', '![画像](a.png)'))).toEqual([
        { type: 'paragraph', lines: ['---', '> 引用', '![画像](a.png)'] },
      ]);
    });
  });

  describe('箇条書き', () => {
    it('- / * / + の項目を 1 つの箇条書きにする', () => {
      expect(parseBlocks(lines('- 一', '* 二', '+ 三'))).toEqual([
        list(false, [['一']], [['二']], [['三']]),
      ]);
    });

    it('番号付きの項目を読む', () => {
      expect(parseBlocks(lines('1. 一', '2) 二', '10. 十'))).toEqual([
        list(true, [['一']], [['二']], [['十']]),
      ]);
    });

    it('番号付きかどうかが変わったら別の箇条書きにする', () => {
      expect(parseBlocks(lines('- 点', '1. 番号'))).toEqual([
        list(false, [['点']]),
        list(true, [['番号']]),
      ]);
    });

    it('深くインデントされた項目を直前の項目の子にする', () => {
      expect(parseBlocks(lines('- 親', '  - 子', '    - 孫', '  - 子 2', '- 親 2'))).toEqual([
        list(
          false,
          [['親'], [list(false, [['子'], [list(false, [['孫']])]], [['子 2']])]],
          [['親 2']]
        ),
      ]);
    });

    it('子の番号付きかどうかが変わったら、同じ親の下の別の箇条書きにする', () => {
      expect(parseBlocks(lines('- 親', '  - 点', '  1. 番号'))).toEqual([
        list(false, [['親'], [list(false, [['点']]), list(true, [['番号']])]]),
      ]);
    });

    it('浅くなった項目で子の箇条書きを閉じる（インデントの幅が揃っていなくてもよい）', () => {
      expect(parseBlocks(lines('- 親', '    - 子', '  - 間'))).toEqual([
        list(false, [['親'], [list(false, [['子']]), list(false, [['間']])]]),
      ]);
    });

    it('インデントされた続きの行を項目の行として持つ', () => {
      const body = lines(
        '- **作業記録へのリンク。** Mastra Factory はカードから Session を開ける。',
        '  ai-board でも、ループが `loop.json` に書くか。',
        '- **並べる。** 二つ目'
      );

      expect(parseBlocks(body)).toEqual([
        list(
          false,
          [
            [
              '**作業記録へのリンク。** Mastra Factory はカードから Session を開ける。',
              'ai-board でも、ループが `loop.json` に書くか。',
            ],
          ],
          [['**並べる。** 二つ目']]
        ),
      ]);
    });

    it('続きの行の後の子の項目も、同じ項目の子にする', () => {
      expect(parseBlocks(lines('- 親', '  続き', '  - 子'))).toEqual([
        list(false, [['親', '続き'], [list(false, [['子']])]]),
      ]);
    });

    it('空行を挟んでも、次が同じ箇条書きの項目なら続ける', () => {
      expect(parseBlocks(lines('- 一', '', '- 二', '', '  続き'))).toEqual([
        list(false, [['一']], [['二', '続き']]),
      ]);
    });

    it('空行の後のインデントされていない行で箇条書きを終える', () => {
      expect(parseBlocks(lines('- 一', '', '文。'))).toEqual<Block[]>([
        list(false, [['一']]),
        { type: 'paragraph', lines: ['文。'] },
      ]);
    });

    it('空行で終わる箇条書き', () => {
      expect(parseBlocks(lines('- 一', '', ''))).toEqual([list(false, [['一']])]);
    });

    it('見出しで箇条書きを終える', () => {
      expect(parseBlocks(lines('- 一', '## 次'))).toEqual<Block[]>([
        list(false, [['一']]),
        { type: 'heading', level: 2, text: '次' },
      ]);
    });

    it('中身の無い項目も項目として読む', () => {
      expect(parseBlocks(lines('-', '- 二'))).toEqual([list(false, [['']], [['二']])]);
    });

    it('強調の ** や区切りの --- は項目にしない', () => {
      expect(parseBlocks(lines('**強調**', '*斜体*'))).toEqual([
        { type: 'paragraph', lines: ['**強調**', '*斜体*'] },
      ]);
    });

    it('タブのインデントを 4 文字分と数える', () => {
      expect(parseBlocks(lines('- 親', '\t- 子'))).toEqual([
        list(false, [['親'], [list(false, [['子']])]]),
      ]);
    });
  });

  describe('コードブロック', () => {
    it('フェンスの中を整形せずに持つ', () => {
      const body = lines(
        '```bash',
        'ai-board card list',
        '# 見出しではない',
        '- 項目ではない',
        '```'
      );

      expect(parseBlocks(body)).toEqual([
        {
          type: 'code',
          info: 'bash',
          text: 'ai-board card list\n# 見出しではない\n- 項目ではない',
        },
      ]);
    });

    it('閉じていなければ本文の終わりまでをコードにする', () => {
      expect(parseBlocks(lines('```', 'a', '', 'b'))).toEqual([
        { type: 'code', info: null, text: 'a\n\nb' },
      ]);
    });

    it('同じ文字で同じ長さ以上のフェンスだけが閉じる', () => {
      const body = lines('````', '```', '~~~', '````', '後');

      expect(parseBlocks(body)).toEqual<Block[]>([
        { type: 'code', info: null, text: '```\n~~~' },
        { type: 'paragraph', lines: ['後'] },
      ]);
    });

    it('フェンスの後ろの文字列を、言語名の後ろまでまとめて持つ', () => {
      expect(parseBlocks(lines('```ts title="a.ts"', 'x', '```'))).toEqual([
        { type: 'code', info: 'ts title="a.ts"', text: 'x' },
      ]);
    });

    it('後ろにバッククォートがある ``` はフェンスにしない', () => {
      expect(parseBlocks('```a``` は段落')).toEqual([
        { type: 'paragraph', lines: ['```a``` は段落'] },
      ]);
    });

    it('~~~ のフェンスも読む', () => {
      expect(parseBlocks(lines('~~~yaml', 'id: x', '~~~'))).toEqual([
        { type: 'code', info: 'yaml', text: 'id: x' },
      ]);
    });
  });

  describe('表', () => {
    it('| で始まる行の並びをまとめて持つ', () => {
      const body = lines('| 主体 | 書く |', '| --- | --- |', '  | 人 | rank |', '後');

      expect(parseBlocks(body)).toEqual<Block[]>([
        { type: 'rows', lines: ['| 主体 | 書く |', '| --- | --- |', '| 人 | rank |'] },
        { type: 'paragraph', lines: ['後'] },
      ]);
    });
  });

  it('カードの本文をまとめて読む', () => {
    const body = lines(
      '## アイデア',
      '',
      'カードの詳細で、本文を整形して表示する。',
      '',
      '- **既定は閲覧。** 見出しを整形する',
      '- **編集は切り替え。**',
      '',
      '## レビュー',
      '',
      '### 2026-10-23T07:18:14.863Z plan 提出',
      '',
      '判断してほしい点'
    );

    expect(parseBlocks(body)).toEqual<Block[]>([
      { type: 'heading', level: 2, text: 'アイデア' },
      { type: 'paragraph', lines: ['カードの詳細で、本文を整形して表示する。'] },
      list(false, [['**既定は閲覧。** 見出しを整形する']], [['**編集は切り替え。**']]),
      { type: 'heading', level: 2, text: 'レビュー' },
      { type: 'heading', level: 3, text: '2026-10-23T07:18:14.863Z plan 提出' },
      { type: 'paragraph', lines: ['判断してほしい点'] },
    ]);
  });

  it('どんな入力にも木を返し、文字を落とさない', () => {
    const pieces = [
      '- ',
      '  ',
      '\t',
      '1. ',
      '#',
      '# ',
      '```',
      '~~~',
      '|',
      'x',
      '**',
      '\n',
      '\n\n',
      '>',
    ];
    let seed = 1;
    const random = (): number => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };

    for (let round = 0; round < 500; round++) {
      let body = '';
      for (let i = 0; i < 40; i++) body += pieces[Math.floor(random() * pieces.length)] ?? '';

      const blocks = parseBlocks(body);
      expect(Array.isArray(blocks)).toBe(true);
      expect(countX(blocks)).toBe([...body].filter((char) => char === 'x').length);
    }
  });
});

/** 木に残った `x` の数。変換で文字が消えていないことを確かめる */
function countX(blocks: readonly Block[]): number {
  const count = (text: string): number => [...text].filter((char) => char === 'x').length;

  return blocks.reduce((sum, block) => {
    switch (block.type) {
      case 'heading':
        return sum + count(block.text);
      case 'code':
        return sum + count(block.text) + count(block.info ?? '');
      case 'paragraph':
      case 'rows':
        return sum + block.lines.reduce((n, line) => n + count(line), 0);
      case 'list':
        return (
          sum +
          block.items.reduce(
            (n, item) =>
              n + item.lines.reduce((m, line) => m + count(line), 0) + countX(item.children),
            0
          )
        );
    }
  }, 0);
}

describe('parseInline', () => {
  const text = (value: string): Span => ({ type: 'text', text: value });
  const code = (value: string): Span => ({ type: 'code', text: value });

  it('飾りの無い行は 1 つの文字にする', () => {
    expect(parseInline('ただの文。')).toEqual([text('ただの文。')]);
    expect(parseInline('')).toEqual([]);
  });

  it('HTML のタグも文字のまま持つ', () => {
    expect(parseInline('<script>alert(1)</script>')).toEqual([text('<script>alert(1)</script>')]);
  });

  describe('インラインコード', () => {
    it('バッククォートで挟んだ所をコードにする', () => {
      expect(parseInline('`ai-board card list` で読む')).toEqual([
        code('ai-board card list'),
        text(' で読む'),
      ]);
    });

    it('同じ本数のバッククォートで閉じる。中の短い並びは文字にする', () => {
      expect(parseInline('`` a ` b ``')).toEqual([code('a ` b')]);
    });

    it('閉じなければバッククォートの並びを文字に戻す', () => {
      expect(parseInline('```a`')).toEqual([text('```a`')]);
      expect(parseInline('a ` b')).toEqual([text('a ` b')]);
    });

    it('コードの中の記法は飾りにしない', () => {
      expect(parseInline('`**x** [a](https://a.example)`')).toEqual([
        code('**x** [a](https://a.example)'),
      ]);
    });
  });

  describe('強調', () => {
    it('** で挟んだ所を強調にする', () => {
      expect(parseInline('**既定は閲覧。** 見出しを整形する')).toEqual([
        { type: 'strong', children: [text('既定は閲覧。')] },
        text(' 見出しを整形する'),
      ]);
    });

    it('強調の中のコードも読む', () => {
      expect(parseInline('**`rank` を書かない**')).toEqual([
        { type: 'strong', children: [code('rank'), text(' を書かない')] },
      ]);
    });

    it('コードの中の ** では閉じない', () => {
      expect(parseInline('**a `**` b**')).toEqual([
        { type: 'strong', children: [text('a '), code('**'), text(' b')] },
      ]);
    });

    it('閉じない、中身が空、空白で始まる ** は文字のまま残す', () => {
      expect(parseInline('**閉じない')).toEqual([text('**閉じない')]);
      expect(parseInline('****')).toEqual([text('****')]);
      expect(parseInline('a ** b ** c')).toEqual([text('a ** b ** c')]);
    });
  });

  describe('リンク', () => {
    it('http / https のリンクを読む', () => {
      expect(parseInline('[PR #33](https://github.com/iepyon/ai-board/pull/33) を見る')).toEqual([
        {
          type: 'link',
          href: 'https://github.com/iepyon/ai-board/pull/33',
          children: [text('PR #33')],
        },
        text(' を見る'),
      ]);
      expect(parseInline('[a](HTTP://a.example)')).toEqual([
        { type: 'link', href: 'HTTP://a.example', children: [text('a')] },
      ]);
    });

    it('ほかのスキームや相対パスは文字のまま残す', () => {
      expect(parseInline('[押す](javascript:alert(1))')).toEqual([
        text('[押す](javascript:alert(1))'),
      ]);
      expect(parseInline('[計画](plans/a.md)')).toEqual([text('[計画](plans/a.md)')]);
    });

    it('リンクの文字の中のコードと入れ子の角括弧を読む', () => {
      expect(parseInline('[`gh` の [説明]](https://cli.github.com)')).toEqual([
        {
          type: 'link',
          href: 'https://cli.github.com',
          children: [code('gh'), text(' の [説明]')],
        },
      ]);
    });

    it('リンクの文字の中にはリンクを作らない', () => {
      expect(parseInline('[[a](https://a.example)](https://b.example)')).toEqual([
        { type: 'link', href: 'https://b.example', children: [text('[a](https://a.example)')] },
      ]);
    });

    it('文字が空なら URL を文字にする', () => {
      expect(parseInline('[](https://a.example)')).toEqual([
        { type: 'link', href: 'https://a.example', children: [text('https://a.example')] },
      ]);
    });

    it('形の崩れたものは文字のまま残す', () => {
      expect(parseInline('[閉じない')).toEqual([text('[閉じない')]);
      expect(parseInline('[a] (https://a.example)')).toEqual([text('[a] (https://a.example)')]);
      expect(parseInline('[a](https://a.example "題")')).toEqual([
        text('[a](https://a.example "題")'),
      ]);
      expect(parseInline('[a](https://a.example')).toEqual([text('[a](https://a.example')]);
    });
  });

  it('どんな入力にも飾りの並びを返し、文字を落とさない', () => {
    const pieces = ['`', '``', '**', '*', '[', ']', '(', ')', 'https://', 'javascript:', ' ', 'x'];
    let seed = 7;
    const random = (): number => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };

    for (let round = 0; round < 1000; round++) {
      let line = '';
      for (let i = 0; i < 30; i++) line += pieces[Math.floor(random() * pieces.length)] ?? '';

      expect(countSpanX(parseInline(line))).toBe([...line].filter((char) => char === 'x').length);
    }
  });
});

function countSpanX(spans: readonly Span[]): number {
  const count = (text: string): number => [...text].filter((char) => char === 'x').length;

  return spans.reduce((sum, span) => {
    switch (span.type) {
      case 'text':
      case 'code':
        return sum + count(span.text);
      case 'strong':
        return sum + countSpanX(span.children);
      case 'link':
        return sum + count(span.href) + countSpanX(span.children);
    }
  }, 0);
}
