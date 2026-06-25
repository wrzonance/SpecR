import { XMLParser } from 'fast-xml-parser';
import { v4 as uuidv4 } from 'uuid';
import type { SpecNode, SpecTree, NodeType, SecRef } from '../../ast/types.js';
import { ParserError } from '../error.js';
import { stripPartPrefix } from '../part-prefix.js';
import type { NteNode, PrtNode, RefNode, SptNode } from './elements.js';
import { decodeXmlEntities } from './entities.js';
import { parseSectionNumberCandidate } from '../../lib/section-number.js';

export type { SecRef };

export interface ParsedSec {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
}

// stopNodes: returns raw XML string instead of parsed object for mixed-content elements.
// fast-xml-parser v5 requires wildcard-prefix syntax '*.ElementName' to match any parent.
const STOP_NODES = ['*.TXT', '*.LST', '*.ITM', '*.NPR', '*.OLI', '*.TTL'];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['PRT', 'SPT', 'NTE', 'NPR', 'TXT', 'LST', 'ITM', 'REF', 'RID', 'RTL', 'OLI'].includes(name),
  stopNodes: STOP_NODES,
  trimValues: true,
  processEntities: false,
});

const HEADING_TAGS = ['HL1', 'HL2', 'HL3', 'HL4', 'HL5', 'HL6'] as const;

// Split on '<' then drop the tag token (everything up to and including '>') from each piece.
// Avoids regex backtracking concerns while preserving inter-tag text. Entities decode AFTER
// tag-stripping — stopNodes return raw XML, so &amp; etc. are still escaped here (the
// "O&amp;M MANUAL CONTENT" bug).
function stripTags(raw: string): string {
  return decodeXmlEntities(
    raw
      .split('<')
      .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('>') + 1)))
      .join(' ')
      .replace(/[ \t\r\n]+/g, ' ')
      .trim()
  );
}

function extractSrfSections(raw: string): string[] {
  return [...raw.matchAll(/<SRF>([^<]+)<\/SRF>/g)].map((m) => m[1]?.trim() ?? '').filter(Boolean);
}

function normalizeTaggedSection(raw: string): string | null {
  const parsed = parseSectionNumberCandidate(raw, 'strong');
  return parsed.ok ? parsed.canonical : null;
}

function toArray<T>(val: T | readonly T[] | undefined): readonly T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? (val as readonly T[]) : [val as T];
}

function makeNode(type: NodeType, text: string, children: SpecNode[], vanish?: boolean): SpecNode {
  return {
    id: uuidv4(),
    type,
    text: text.trim() || type,
    children,
    meta: { source: 'ufgs', ...(vanish === true ? { vanish: true } : {}) },
  };
}

function sptNodeType(depth: number): NodeType {
  switch (depth) {
    case 0:
      return 'article';
    case 1:
      return 'pr1';
    case 2:
      return 'pr2';
    case 3:
      return 'pr3';
    case 4:
      return 'pr4';
    case 5:
      return 'pr5';
    case 6:
      return 'pr6';
    default:
      return 'pr7';
  }
}

function walkNte(nte: NteNode): SpecNode[] {
  return toArray(nte.NPR)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((raw) => makeNode('note', stripTags(raw), [], true));
}

function pushSrfRefs(raw: string, nodeId: string, refs: SecRef[]): void {
  for (const sec of extractSrfSections(raw)) {
    refs.push({
      sourceNodeId: nodeId,
      targetType: 'section',
      // Normalize-or-verbatim: a tagged ref is never rejected; exact-match
      // resolution simply won't find non-conforming targets.
      targetSpecSection: normalizeTaggedSection(sec) ?? sec,
      referenceText: stripTags(raw).slice(0, 200),
    });
  }
}

function walkTextItems(
  items: readonly (string | undefined)[],
  type: NodeType,
  children: SpecNode[],
  refs: SecRef[]
): void {
  for (const raw of items) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const node = makeNode(type, stripTags(raw), []);
    children.push(node);
    pushSrfRefs(raw, node.id, refs);
  }
}

function walkOlg(spt: SptNode, type: NodeType, children: SpecNode[], refs: SecRef[]): void {
  if (!spt.OLG) return;
  walkTextItems(toArray(spt.OLG.OLI), type, children, refs);
}

function buildStandardRef(sourceNodeId: string, code: string, rtl: string): SecRef {
  return {
    sourceNodeId,
    targetType: 'standard',
    standardCode: code,
    referenceText: rtl ? `${code} ${rtl}` : code,
  };
}

function pushRefsForRids(refs: SecRef[], sourceNodeId: string, ref: RefNode): void {
  const rids = toArray(ref.RID);
  const rtls = ref.RTL ?? [];
  rids.forEach((rid, i) => {
    // RID/RTL are parsed with processEntities: false — decode here
    const code = typeof rid === 'string' ? decodeXmlEntities(rid.trim()) : '';
    if (!code) return;
    const rtlEntry = rtls[i];
    const rtl = typeof rtlEntry === 'string' ? decodeXmlEntities(rtlEntry.trim()) : '';
    refs.push(buildStandardRef(sourceNodeId, code, rtl));
  });
}

function pushStandardRefs(
  refs: SecRef[],
  sourceNodeId: string,
  refNodes: readonly RefNode[]
): void {
  for (const ref of refNodes) {
    pushRefsForRids(refs, sourceNodeId, ref);
  }
}

function walkSpt(spt: SptNode, refs: SecRef[], depth: number): SpecNode {
  const ttlRaw = typeof spt.TTL === 'string' ? spt.TTL : '';
  const children: SpecNode[] = [];

  for (const nte of toArray(spt.NTE)) {
    children.push(...walkNte(nte));
  }
  walkTextItems(toArray(spt.TXT), 'continuation', children, refs);
  walkTextItems(toArray(spt.LST), sptNodeType(depth + 1), children, refs);
  walkTextItems(toArray(spt.ITM), sptNodeType(depth + 2), children, refs);
  walkOlg(spt, sptNodeType(depth + 1), children, refs);
  for (const nested of toArray(spt.SPT)) {
    children.push(walkSpt(nested, refs, depth + 1));
  }

  const node = makeNode(sptNodeType(depth), stripTags(ttlRaw) || 'UNTITLED', children);
  pushStandardRefs(refs, node.id, spt.REF ?? []);
  return node;
}

function walkPrt(prt: PrtNode, refs: SecRef[]): SpecNode {
  const ttlRaw = typeof prt.TTL === 'string' ? prt.TTL : '';
  const partChildren: SpecNode[] = [];

  for (const nte of toArray(prt.NTE)) {
    partChildren.push(...walkNte(nte));
  }
  for (const spt of toArray(prt.SPT)) {
    partChildren.push(walkSpt(spt, refs, 0));
  }

  return makeNode('part', stripPartPrefix(stripTags(ttlRaw)) || 'PART', partChildren);
}

function requireString(val: unknown, fieldName: string): string {
  if (typeof val !== 'string' || !val.trim()) {
    throw new ParserError(`SEC file missing <${fieldName}> element`);
  }
  return val.trim();
}

function optionalString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

function metadataString(
  sec: Record<string, unknown>,
  fieldName: 'SCN' | 'STL'
): string | undefined {
  const direct = optionalString(sec[fieldName]);
  if (direct !== undefined) return direct;

  for (const tag of HEADING_TAGS) {
    const wrapped = toArray(sec[tag]);
    for (const candidate of wrapped) {
      const nested = asRecord(candidate);
      const value = nested === undefined ? undefined : optionalString(nested[fieldName]);
      if (value !== undefined) return value;
    }
  }

  return undefined;
}

export function parseSec(xml: string): ParsedSec {
  let root: unknown;
  try {
    root = xmlParser.parse(xml) as unknown;
  } catch (err) {
    throw new ParserError('failed to parse SEC XML', { cause: err });
  }

  const sec = (root as Record<string, unknown>)['SEC'] as Record<string, unknown> | undefined;
  if (!sec) throw new ParserError('SEC root element not found');

  // SCN/STL are parsed with processEntities: false — decode here.
  // Normalize-or-verbatim: canonicalize section whitespace when the value is a
  // valid expanded-shape number; keep verbatim otherwise. Tagged values are
  // never rejected here — exact-match linkage simply won't find
  // non-conforming sections (validation gates arrive with the API schema +
  // DB CHECK constraint work).
  const scnRaw = decodeXmlEntities(metadataString(sec, 'SCN') ?? '')
    .replace(/^SECTION\s+/i, '')
    .trim();
  const section = scnRaw.length > 0 ? (normalizeTaggedSection(scnRaw) ?? scnRaw) : 'unknown';
  const title = decodeXmlEntities(requireString(metadataString(sec, 'STL'), 'STL'));

  const refs: SecRef[] = [];
  const parts = toArray(sec['PRT'] as readonly PrtNode[] | undefined).map((prt) =>
    walkPrt(prt, refs)
  );

  return { tree: { id: uuidv4(), section, title, parts }, refs };
}

export { assertSecSafe } from './safety.js';
