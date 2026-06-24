import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { asRecord, extractAttrStr, toArray } from './xml-utils.js';

export interface DocxComment {
  readonly author: string;
  readonly text: string;
  /** True when any run in the comment carries an active `w:strike` toggle (#262). */
  readonly struck: boolean;
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

// OOXML toggle (ECMA-376 §17.3.2.43): a present element with no w:val, or a w:val
// that is not one of 0/false/off, is ON. A self-closing `<w:strike/>` parses as the
// empty string (present, no attrs) → ON. Mirrors resolver.ts `toggle`, kept local so
// comments.ts owns no cross-module run-property dependency.
function isStrikeOn(strikeEl: unknown): boolean {
  if (strikeEl === undefined) return false;
  const val = extractAttrStr(asRecord(strikeEl) ?? {}, '@_w:val');
  return val !== '0' && val !== 'false' && val !== 'off';
}

// True if any run (w:r) under the comment carries an active w:strike toggle on its
// w:rPr. Walks the whole comment subtree because runs can nest under w:p, w:hyperlink,
// w:smartTag, etc. — the run, not the paragraph, owns the strike property.
function commentHasStrike(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const runs = toArray(record['w:r']);
  for (const run of runs) {
    const rPr = asRecord(asRecord(run)?.['w:rPr']);
    if (rPr && isStrikeOn(rPr['w:strike'])) return true;
  }
  return Object.entries(record).some(
    ([key, child]) => key !== 'w:r' && !key.startsWith('@_') && deepHasStrike(child)
  );
}

function deepHasStrike(child: unknown): boolean {
  if (Array.isArray(child)) return child.some(commentHasStrike);
  return commentHasStrike(child);
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
        struck: commentHasStrike(comment),
      },
    ];
  });

  return new Map(entries);
}
