import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { asRecord, extractAttrStr, toArray } from './xml-utils.js';

export interface DocxComment {
  readonly author: string;
  readonly text: string;
}

const commentsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  isArray: (name) => ['w:comment', 'w:p', 'w:r'].includes(name),
});

function textFromNode(node: unknown): string {
  if (typeof node === 'string') return node;
  const record = asRecord(node);
  const text = record?.['#text'];
  return typeof text === 'string' ? text : '';
}

function collectText(value: unknown): readonly string[] {
  const record = asRecord(value);
  if (!record) return [];

  const direct = toArray(record['w:t']).map(textFromNode);
  const nested = Object.entries(record)
    .filter(([key]) => key !== 'w:t' && key !== '#text' && !key.startsWith('@_'))
    .flatMap(([, child]) =>
      Array.isArray(child) ? child.flatMap(collectText) : collectText(child)
    );

  return [...direct, ...nested].filter((part) => part.length > 0);
}

export function parseCommentsXml(xml: string): ReadonlyMap<string, DocxComment> {
  let parsed: unknown;
  try {
    parsed = commentsParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse word/comments.xml', { cause: err });
  }

  const root = asRecord(parsed)?.['w:comments'];
  const commentsRoot = asRecord(root);
  if (!commentsRoot) throw new ParserError('word/comments.xml missing w:comments element');

  const entries = toArray(commentsRoot['w:comment']).map((raw): readonly [string, DocxComment] => {
    const comment = asRecord(raw);
    if (!comment) throw new ParserError('word/comments.xml contains an invalid comment');
    const id = extractAttrStr(comment, '@_w:id');
    if (!id) throw new ParserError('word/comments.xml comment missing w:id');
    return [
      id,
      {
        author: extractAttrStr(comment, '@_w:author'),
        text: collectText(comment).join(''),
      },
    ];
  });

  return new Map(entries);
}
