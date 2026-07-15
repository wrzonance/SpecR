// Recovers the TRUE document order of a header/footer paragraph's terminal
// content elements (w:r, w:fldSimple) — order information header-footer-
// region.ts's own grouped-mode partParser structurally cannot retain (#485
// review, CRITICAL). fast-xml-parser's tag-grouped (non-preserveOrder) object
// model collapses every same-tag sibling into one array keyed by first
// appearance: when a w:fldSimple sits BETWEEN two plain w:r runs, the SECOND
// w:r merges into the FIRST w:r's array instead of staying interleaved after
// the field — Object.entries iteration then reflects first-tag-appearance,
// not true document order, silently reordering captured content.
//
// A companion preserveOrder-mode parse of the identical XML retains true
// document order (mirrors merge/extract.ts and source-facts.ts's own
// established use of this fast-xml-parser mode for exactly this class of
// problem — see both files' own module comments). walkOrder below pairs each
// preserveOrder node back to the SAME xml's already-parsed grouped-mode
// object — matched by tag name plus a per-tag occurrence cursor at each
// recursion frame, which is reliable because grouped mode DOES preserve
// same-tag relative order among any one parent's own direct children; only
// CROSS-tag order is lost — and records its true ordinal into a side-table,
// never mutating the parsed record itself (house rule: never mutate inputs).

import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { toArray } from './xml-utils.js';
import type { HeaderFooterUnmodeledEntry } from './types.js';

// fast-xml-parser preserveOrder node: one element key -> children array,
// '#text' -> string, ':@' -> attribute record. Mirrors merge/extract.ts's own
// OrderedNode and source-facts.ts's equivalent parser config.
interface OrderedNode {
  readonly [key: string]: unknown;
}

const orderedPartParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  preserveOrder: true,
});

// A side-table, not a property stamped onto the parsed records themselves:
// mutating a run/paragraph object would leak an extra key into every
// `compact(paragraph)` unmodeled `detail` blob built from it elsewhere in
// header-footer-region.ts, corrupting the "detail is the raw paragraph
// verbatim" losslessness invariant (#484/#485 review).
export type RunOrder = ReadonlyMap<Record<string, unknown>, number>;

function tagOf(node: OrderedNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

function childrenOf(node: OrderedNode, tag: string): readonly OrderedNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function findChild(nodes: readonly OrderedNode[], tag: string): readonly OrderedNode[] {
  const match = nodes.find((node) => tagOf(node) === tag);
  return match ? childrenOf(match, tag) : [];
}

// Skipped everywhere header-footer-region.ts's own collectRunsAndFields skips
// (w:rPr/w:pPr carry no content; '#text' is insignificant inter-tag
// whitespace, never a wrapper) — so this side-table's recursion visits
// exactly the same tags the collector does.
const SKIP_KEYS: ReadonlySet<string> = new Set(['w:rPr', 'w:pPr', '#text']);

function pairedGroupedChild(
  groupedNode: Record<string, unknown>,
  tag: string,
  index: number
): Record<string, unknown> | undefined {
  return toArray<Record<string, unknown>>(
    groupedNode[tag] as readonly Record<string, unknown>[] | undefined
  )[index];
}

function walkOrder(
  groupedNode: Record<string, unknown>,
  orderedSiblings: readonly OrderedNode[],
  order: Map<Record<string, unknown>, number>,
  cursor: { next: number }
): void {
  const seen = new Map<string, number>();
  for (const sibling of orderedSiblings) {
    const tag = tagOf(sibling);
    if (tag === undefined || SKIP_KEYS.has(tag)) continue;
    const index = seen.get(tag) ?? 0;
    seen.set(tag, index + 1);
    const groupedChild = pairedGroupedChild(groupedNode, tag, index);
    if (!groupedChild) continue;
    if (tag === 'w:r' || tag === 'w:fldSimple') {
      order.set(groupedChild, cursor.next++);
      continue;
    }
    walkOrder(groupedChild, childrenOf(sibling, tag), order, cursor);
  }
}

function parseOrdered(
  partXml: string,
  region: HeaderFooterUnmodeledEntry['region']
): readonly OrderedNode[] {
  try {
    return orderedPartParser.parse(partXml) as OrderedNode[];
  } catch (err) {
    throw new ParserError(`failed to order-parse word/${region} part XML`, {
      code: 'DOCX_HEADER_FOOTER_XML_INVALID',
      cause: err,
    });
  }
}

/**
 * Build the run-ordinal side-table for one header/footer part: every w:r and
 * w:fldSimple grouped-mode object — however deeply nested inside
 * w:hyperlink/w:ins/w:del/w:sdt wrappers — is keyed to its TRUE document-
 * order position across the whole part, so header-footer-region.ts's runsOf
 * can restore correct content order that its own grouped-mode traversal
 * alone cannot see (#485 review). `groupedRoot` is the SAME partXml's
 * already-parsed w:hdr/w:ftr root (header-footer-region.ts's own partParser
 * output) — this never re-derives it, only pairs against it.
 */
export function computeRunOrder(
  partXml: string,
  rootTag: 'w:hdr' | 'w:ftr',
  groupedRoot: Record<string, unknown>,
  region: HeaderFooterUnmodeledEntry['region']
): RunOrder {
  const orderedRoot = findChild(parseOrdered(partXml, region), rootTag);
  const order = new Map<Record<string, unknown>, number>();
  walkOrder(groupedRoot, orderedRoot, order, { next: 0 });
  return order;
}
