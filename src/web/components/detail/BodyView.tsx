import { Fragment, memo, useMemo } from 'react';
import {
  parseBlocks,
  parseInline,
  type Block,
  type ListBlock,
  type Span,
} from '../../../shared/markdown.js';

// ============================================================
// Markdown 本文の表示
// ============================================================

/**
 * 本文を整形して出す。変換は `src/shared/markdown.ts` が済ませており、ここは木を要素に写すだけにする。
 *
 * 本文は人もエージェントも書ける場所なので、HTML の文字列は作らない。
 * 文字はすべて React のテキストとして渡り、エスケープされる。
 */
export function BodyView({ body }: { body: string }) {
  const blocks = useMemo(() => parseBlocks(body), [body]);

  if (blocks.length === 0) {
    return <p className="movable">本文はまだありません。</p>;
  }

  return <MarkdownBlocks blocks={blocks} />;
}

/**
 * 変換済みのブロックの木を要素に写す。本文の欄と、判断の記録の理由（`parseReasonBlocks` の木）で使う。
 * 木の作り方は呼び出し側が決め、ここは描くだけにする。
 */
export function MarkdownBlocks({
  blocks,
  className,
}: {
  blocks: readonly Block[];
  className?: string;
}) {
  return (
    <div className={className === undefined ? 'md-body' : `md-body ${className}`}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

/**
 * 見出しの要素。詳細パネルはカードのタイトルに h2、区画の名前に h3 を使っているので、
 * 本文の見出しはその下の h4 から始める。
 */
const HEADING_TAGS = ['h4', 'h4', 'h5', 'h6', 'h6', 'h6'] as const;

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const Tag = HEADING_TAGS[block.level - 1] ?? 'h6';
      return (
        <Tag className={`md-heading md-h${block.level}`}>
          <Inline text={block.text} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="md-paragraph">
          <Lines lines={block.lines} />
        </p>
      );
    case 'list':
      return <ListView list={block} />;
    case 'code':
      return (
        <pre className="md-code" data-info={block.info ?? undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'rows':
      return (
        <pre className="md-rows">
          <code>{block.lines.join('\n')}</code>
        </pre>
      );
  }
}

function ListView({ list }: { list: ListBlock }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      <Lines lines={item.lines} />
      {item.children.map((child, childIndex) => (
        <BlockView key={childIndex} block={child} />
      ))}
    </li>
  ));

  return list.ordered ? (
    <ol className="md-list" start={list.start}>
      {items}
    </ol>
  ) : (
    <ul className="md-list">{items}</ul>
  );
}

/** 一文一行で書いた本文を 1 行につながず、改行のまま出す */
function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 && <br />}
          <Inline text={line} />
        </Fragment>
      ))}
    </>
  );
}

/** 行ごとに変換する。本文が変わらない再描画（保存中の表示の切り替えなど）では変換し直さない */
const Inline = memo(function Inline({ text }: { text: string }) {
  return <Spans spans={parseInline(text)} />;
});

function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <SpanView key={index} span={span} />
      ))}
    </>
  );
}

function SpanView({ span }: { span: Span }) {
  switch (span.type) {
    case 'text':
      return <>{span.text}</>;
    case 'code':
      return <code className="md-inline-code">{span.text}</code>;
    case 'strong':
      return (
        <strong>
          <Spans spans={span.children} />
        </strong>
      );
    case 'link':
      return (
        <a href={span.href} target="_blank" rel="noreferrer">
          <Spans spans={span.children} />
        </a>
      );
  }
}
