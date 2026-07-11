import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { MergeError } from './error.js';
import type { ExtractResult, TrackChangeRecord } from './types.js';

const UUID_TAG_PREFIX = 'specr-uuid-';

// preserveOrder keeps w:sdt blocks and bare w:p siblings in document order —
// required for orphan indexes (non-preserveOrder grouping destroys ordering).
// parseTagValue: false per issue #120 (bare-integer <w:t> runs would be coerced
// to numbers and dropped). trimValues: false preserves run-boundary spaces.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
});

// fast-xml-parser preserveOrder node: one element key → children array,
// '#text' → string, ':@' → attribute record.
interface OrderedNode {
  readonly [key: string]: unknown;
}

interface ParaContext {
  readonly uuid: string | undefined;
  readonly records: TrackChangeRecord[];
}

interface ExtractAcc {
  readonly controlled: Map<string, string>;
  readonly orphans: {
    readonly text: string;
    readonly index: number;
    readonly afterUuid: string | undefined;
  }[];
  readonly records: TrackChangeRecord[];
}

/** Document-order walk position: next orphan index + nearest preceding controlled uuid. */
interface WalkState {
  readonly index: number;
  readonly lastControlledUuid: string | undefined;
}

// Formatting-property subtrees that must never contribute text content
// (w:pPr > w:tabs > w:tab would otherwise inject phantom tabs).
const PROPERTY_TAGS = new Set(['w:pPr', 'w:rPr', 'w:sdtPr', 'w:sdtEndPr']);

function tagOf(node: OrderedNode): string | undefined {
  return Object.keys(node).find((k) => k !== ':@');
}

function childrenOf(node: OrderedNode, tag: string): readonly OrderedNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function attrStr(node: OrderedNode, name: string): string | undefined {
  const attrs = node[':@'];
  if (typeof attrs !== 'object' || attrs === null) return undefined;
  const value = (attrs as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/** Concatenated '#text' descendants of an element (e.g. w:t, w:delText). */
function elementText(node: OrderedNode, tag: string): string {
  return childrenOf(node, tag)
    .map((child) => {
      const childTag = tagOf(child);
      if (childTag === undefined) return '';
      if (childTag === '#text') {
        const value = child['#text'];
        return typeof value === 'string' ? value : '';
      }
      return elementText(child, childTag);
    })
    .join('');
}

function makeRecord(
  kind: 'ins' | 'del',
  node: OrderedNode,
  text: string,
  uuid: string | undefined
): TrackChangeRecord {
  return {
    kind,
    uuid,
    text,
    author: attrStr(node, '@_w:author'),
    date: attrStr(node, '@_w:date'),
  };
}

/** Raw text inside a w:del subtree: Word uses w:delText; accept w:t as superset. */
function deletedText(nodes: readonly OrderedNode[]): string {
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    if (tag === 'w:delText' || tag === 'w:t') out += elementText(node, tag);
    else out += deletedText(childrenOf(node, tag));
  }
  return out;
}

function visitRunNode(node: OrderedNode, tag: string, ctx: ParaContext): string {
  if (tag === 'w:t') return elementText(node, tag);
  if (tag === 'w:tab') return '\t';
  if (tag === 'w:br') return '\n';
  if (tag === 'w:noBreakHyphen') return '';
  if (tag === 'w:ins') {
    const text = visibleText(childrenOf(node, tag), ctx);
    ctx.records.push(makeRecord('ins', node, text, ctx.uuid));
    return text;
  }
  if (tag === 'w:del') {
    ctx.records.push(makeRecord('del', node, deletedText(childrenOf(node, tag)), ctx.uuid));
    return ''; // virtual-accept: deleted text is excluded from paragraph text
  }
  return visibleText(childrenOf(node, tag), ctx); // w:r, w:hyperlink, w:smartTag, …
}

/** Visible (post virtual-accept) text of paragraph content nodes, in order. */
function visibleText(nodes: readonly OrderedNode[], ctx: ParaContext): string {
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    out += visitRunNode(node, tag, ctx);
  }
  return out;
}

/** specr uuid from a single w:sdtPr's child w:tag w:val, if SpecR-tagged. */
function readUuidFromSdtPr(sdtPr: OrderedNode): string | undefined {
  for (const prChild of childrenOf(sdtPr, 'w:sdtPr')) {
    if (tagOf(prChild) !== 'w:tag') continue;
    const value = attrStr(prChild, '@_w:val');
    if (value !== undefined && value.startsWith(UUID_TAG_PREFIX)) {
      return value.slice(UUID_TAG_PREFIX.length);
    }
  }
  return undefined;
}

/** specr uuid from a w:sdt node's w:sdtPr > w:tag w:val, if tagged by SpecR. */
function readSdtUuid(sdt: OrderedNode): string | undefined {
  for (const child of childrenOf(sdt, 'w:sdt')) {
    if (tagOf(child) !== 'w:sdtPr') continue;
    const uuid = readUuidFromSdtPr(child);
    if (uuid !== undefined) return uuid;
  }
  return undefined;
}

/** Merge text into the controlled map: concatenate with '\n' if uuid already present. */
function setControlledText(controlled: Map<string, string>, uuid: string, text: string): void {
  const existing = controlled.get(uuid);
  controlled.set(uuid, existing !== undefined ? `${existing}\n${text}` : text);
}

function visitParagraph(
  node: OrderedNode,
  uuid: string | undefined,
  acc: ExtractAcc,
  state: WalkState
): WalkState {
  const text = visibleText(childrenOf(node, 'w:p'), { uuid, records: acc.records });
  if (!text.trim()) return state; // whitespace-only spacer paragraphs ignored
  if (uuid !== undefined) {
    setControlledText(acc.controlled, uuid, text);
    return { index: state.index + 1, lastControlledUuid: uuid };
  }
  acc.orphans.push({ text, index: state.index, afterUuid: state.lastControlledUuid });
  return { index: state.index + 1, lastControlledUuid: state.lastControlledUuid };
}

/** Walk block-level nodes in document order, tracking the enclosing sdt uuid. */
function walkBlocks(
  nodes: readonly OrderedNode[],
  uuid: string | undefined,
  acc: ExtractAcc,
  state: WalkState
): WalkState {
  let s = state;
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    if (tag === 'w:sdt') {
      s = walkBlocks(childrenOf(node, tag), readSdtUuid(node) ?? uuid, acc, s);
    } else if (tag === 'w:p') {
      s = visitParagraph(node, uuid, acc, s);
    } else {
      s = walkBlocks(childrenOf(node, tag), uuid, acc, s); // w:document, w:body, w:sdtContent, w:tbl, …
    }
  }
  return s;
}

async function loadZip(buffer: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new MergeError('not a valid DOCX buffer', { cause: err });
  }
}

function parseDocumentXml(xml: string): readonly OrderedNode[] {
  try {
    // Cast is safe: every downstream accessor (tagOf/childrenOf/attrStr) type-guards
    // before accessing fields, so unexpected shapes degrade to empty output rather than throwing.
    return xmlParser.parse(xml) as OrderedNode[];
  } catch (err) {
    throw new MergeError('failed to parse word/document.xml', { cause: err });
  }
}

/**
 * Unzip a DOCX buffer, parse word/document.xml, and return every non-empty
 * paragraph keyed by its specr-uuid content-control tag (ADR-004 anchors).
 * Track changes are accepted virtually (w:ins counted, w:del excluded) and
 * recorded raw for downstream consumers (ADR-005 Phase 3a).
 */
export async function extractContentControls(docxBuffer: Buffer): Promise<ExtractResult> {
  const zip = await loadZip(docxBuffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new MergeError('DOCX missing word/document.xml');
  const xml = await file.async('string');
  const nodes = parseDocumentXml(xml);

  const acc: ExtractAcc = { controlled: new Map(), orphans: [], records: [] };
  walkBlocks(nodes, undefined, acc, { index: 0, lastControlledUuid: undefined });

  return {
    controlled: acc.controlled,
    orphans: acc.orphans,
    trackChanges: { present: acc.records.length > 0, records: acc.records },
  };
}
