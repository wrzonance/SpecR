// Cross-tag body order (#300, ADR-072): a preserveOrder walk of word/document.xml
// that recovers where each body-level w:tbl sits relative to the surrounding w:p
// paragraphs — ordering document.ts's grouped-mode parse structurally cannot see
// (same-tag grouping collapses every w:p sibling into one array, losing its
// position relative to any interleaved w:tbl). Mirrors the established
// preserveOrder-pairing technique in header-footer-run-order.ts and
// merge/extract.ts for this exact class of problem.

import { ParserError } from '../error.js';
import { createOrderedDocumentXmlParser } from './xml-utils.js';
import { ObjectBlobNodeSchema } from '../../ast/index.js';
import type { ObjectBlobNode } from '../../ast/index.js';

const orderedBodyParser = createOrderedDocumentXmlParser();

/**
 * One body-level w:tbl. `precedingParagraphIndex` is the array index — into
 * document.ts's own grouped-mode `body['w:p']` array — of the paragraph
 * immediately preceding this table in document order, or `undefined` when
 * the table sits before the body's first paragraph (or the body has no
 * paragraphs at all). `blob` is the table's own ordered node, wrapped in a
 * single-element array to match `ObjectMeta.blob`'s "top-level node(s) in
 * document order" convention.
 */
export interface BodyOrderTable {
  readonly precedingParagraphIndex: number | undefined;
  readonly blob: readonly ObjectBlobNode[];
}

/**
 * Cross-tag document-order data for one word/document.xml. `paragraphBlobs[i]`
 * is index-aligned with document.ts's own `body['w:p']` array order — pinned
 * as an invariant by body-order.test.ts — so a caller that already parsed the
 * document via document.ts can pair a paragraph's index straight into this
 * array with no second lookup.
 */
export interface BodyOrder {
  readonly tables: readonly BodyOrderTable[];
  readonly paragraphBlobs: readonly (readonly ObjectBlobNode[])[];
}

function tagOf(node: ObjectBlobNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

// A hand-written type guard, not a bare `Array.isArray(value)` check: TS narrows
// `Array.isArray` over a `readonly ObjectBlobNode[] | string` union to `any[]`
// (a known lib.es5.d.ts limitation for readonly-array unions), which would make
// the caller's return an unsafe `any[]`. Declaring the predicate explicitly keeps
// the narrowed type exactly `readonly ObjectBlobNode[]`, with no cast.
function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function childrenOf(node: ObjectBlobNode, tag: string): readonly ObjectBlobNode[] {
  const value = node[tag];
  return isBlobNodeArray(value) ? value : [];
}

function findChild(nodes: readonly ObjectBlobNode[], tag: string): readonly ObjectBlobNode[] {
  const match = nodes.find((node) => tagOf(node) === tag);
  return match ? childrenOf(match, tag) : [];
}

function parseOrderedBody(documentXml: string): readonly ObjectBlobNode[] {
  let parsed: unknown;
  try {
    parsed = orderedBodyParser.parse(documentXml);
  } catch (err) {
    throw new ParserError('failed to order-parse word/document.xml for body object placement', {
      code: 'DOCX_BODY_ORDER_XML_INVALID',
      cause: err,
    });
  }
  try {
    return ObjectBlobNodeSchema.array().parse(parsed);
  } catch (err) {
    throw new ParserError(
      'word/document.xml preserveOrder parse produced an unexpected node shape',
      { code: 'DOCX_BODY_ORDER_XML_INVALID', cause: err }
    );
  }
}

/**
 * Walks word/document.xml's w:body DIRECT children only (fast-xml-parser
 * preserveOrder mode) — a w:tbl or w:p nested inside a table cell is never
 * visited, mirroring tables.ts's findTopLevelTables scope (KNOWN AMBIGUITY,
 * #293 design decision #6, carried forward by ADR-072 decision 20).
 */
export function computeBodyOrder(documentXml: string): BodyOrder {
  const roots = parseOrderedBody(documentXml);
  const documentChildren = findChild(roots, 'w:document');
  const body = findChild(documentChildren, 'w:body');

  const tables: BodyOrderTable[] = [];
  const paragraphBlobs: (readonly ObjectBlobNode[])[] = [];
  let lastParagraphIndex: number | undefined;

  for (const node of body) {
    const tag = tagOf(node);
    if (tag === 'w:p') {
      lastParagraphIndex = paragraphBlobs.length;
      paragraphBlobs.push([node]);
    } else if (tag === 'w:tbl') {
      tables.push({ precedingParagraphIndex: lastParagraphIndex, blob: [node] });
    }
  }

  return { tables, paragraphBlobs };
}
