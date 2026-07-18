import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { UUID_TAG_PREFIX } from '../ast/index.js';
import { MergeError } from './error.js';
import { fingerprintBlob } from './object-fingerprint.js';
import type { ExtractResult, ExtractedObjectBlock, TrackChangeRecord } from './types.js';

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
  /** shared reference to the top-level walk's controlled map — lets a
   *  text-box run (visitRunNode's w:drawing/w:pict branch) capture interior
   *  specr-uuid anchors without threading the whole ExtractAcc through. */
  readonly controlled: Map<string, string>;
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
  if (tag === 'w:drawing' || tag === 'w:pict') {
    // gap-1 (#520): a text box's interior specr-uuid anchor lives inside this
    // run's subtree, not among the host paragraph's block-level siblings, so
    // the generic run-content fallthrough below would otherwise absorb its
    // text into the host paragraph. Captured separately (collectDrawingAnchors)
    // and contributes no text here.
    collectDrawingAnchors(childrenOf(node, tag), ctx);
    return '';
  }
  return visibleText(childrenOf(node, tag), ctx); // w:r, w:hyperlink, w:smartTag, …
}

/**
 * Walks a text-box drawing's subtree (DrawingML `wps:txbx`/`w:txbxContent` or
 * VML `v:textbox`/`w:txbxContent`) for interior specr-uuid `w:sdt` anchors,
 * writing their paragraph text into the shared controlled map. Reuses
 * `walkBlocks` unmodified: the DrawingML/VML wrapper tags (`wp:inline`,
 * `a:graphic`, `a:graphicData`, `wps:txbx`, `v:shape`, `v:textbox`, …) all
 * fall through `walkBlocks`'s generic recursion case with zero tag-specific
 * dispatch needed. Orphan paragraphs inside a drawing (no specr-uuid anchor)
 * are discarded — a drawing/shape body has no CSI tier to anchor an addition
 * against, mirroring the table-cell anchorless rule. Track-change records
 * ARE preserved: `ctx.records` is the same array reference as the top-level
 * walk's.
 */
function collectDrawingAnchors(nodes: readonly OrderedNode[], ctx: ParaContext): void {
  const throwawayAcc: ExtractAcc = {
    controlled: ctx.controlled,
    orphans: [],
    records: ctx.records,
  };
  walkBlocks(nodes, undefined, throwawayAcc, { index: 0, lastControlledUuid: undefined }, false);
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
  state: WalkState,
  inTable: boolean
): WalkState {
  const text = visibleText(childrenOf(node, 'w:p'), {
    uuid,
    records: acc.records,
    controlled: acc.controlled,
  });
  if (!text.trim()) return state; // whitespace-only spacer paragraphs ignored
  if (uuid !== undefined) {
    setControlledText(acc.controlled, uuid, text);
    return { index: state.index + 1, lastControlledUuid: uuid };
  }
  // A table-cell paragraph has no CSI tier, so it must never anchor a merge
  // addition (flattening it into a body sibling would corrupt structure, #374):
  // keep it anchorless (afterUuid undefined) EVEN when a controlled paragraph
  // precedes the table, so it flows into the merge's anchorless-addition
  // rejection instead of silently applying. See the KNOWN AMBIGUITY test.
  const afterUuid = inTable ? undefined : state.lastControlledUuid;
  acc.orphans.push({ text, index: state.index, afterUuid });
  return { index: state.index + 1, lastControlledUuid: state.lastControlledUuid };
}

/** Walk block-level nodes in document order, tracking the enclosing sdt uuid
 *  and whether the walk has descended into a w:tbl (table cells never anchor). */
function walkBlocks(
  nodes: readonly OrderedNode[],
  uuid: string | undefined,
  acc: ExtractAcc,
  state: WalkState,
  inTable: boolean
): WalkState {
  let s = state;
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    if (tag === 'w:sdt') {
      s = walkBlocks(childrenOf(node, tag), readSdtUuid(node) ?? uuid, acc, s, inTable);
    } else if (tag === 'w:p') {
      s = visitParagraph(node, uuid, acc, s, inTable);
    } else {
      // w:document, w:body, w:sdtContent, w:tbl, … — a w:tbl marks its whole
      // subtree as table-descended so its cell paragraphs stay anchorless.
      s = walkBlocks(childrenOf(node, tag), uuid, acc, s, inTable || tag === 'w:tbl');
    }
  }
  return s;
}

const OBJECT_BLOCK_TAGS = new Set(['w:tbl', 'w:drawing', 'w:pict']);

/** Every specr-uuid `w:sdt` anchor's uuid found anywhere in `nodes`, in document order. */
function findInteriorUuids(nodes: readonly OrderedNode[]): string[] {
  const uuids: string[] = [];
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    if (tag === 'w:sdt') {
      const uuid = readSdtUuid(node);
      if (uuid !== undefined) uuids.push(uuid);
    }
    uuids.push(...findInteriorUuids(childrenOf(node, tag)));
  }
  return uuids;
}

/**
 * Walks the document for body-level object blocks (#520): a `w:tbl` table or
 * a `w:drawing`/`w:pict` text box, fingerprinted (object-fingerprint.ts) for
 * structural-conflict detection. `inBlock` dedups nested structure (e.g. a
 * table nested inside another table's cell) — once inside a detected block,
 * its subtree is scanned only for interior uuids/fingerprinting, never
 * re-detected as its own separate block.
 */
function walkObjectBlocks(
  nodes: readonly OrderedNode[],
  inBlock: boolean,
  blocks: ExtractedObjectBlock[]
): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    const isObjectTag = OBJECT_BLOCK_TAGS.has(tag);
    if (isObjectTag && !inBlock) {
      blocks.push({
        interiorUuids: findInteriorUuids(childrenOf(node, tag)),
        fingerprint: fingerprintBlob([node]),
      });
    }
    walkObjectBlocks(childrenOf(node, tag), inBlock || isObjectTag, blocks);
  }
}

function extractObjectBlocks(nodes: readonly OrderedNode[]): ExtractedObjectBlock[] {
  const blocks: ExtractedObjectBlock[] = [];
  walkObjectBlocks(nodes, false, blocks);
  return blocks;
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
  walkBlocks(nodes, undefined, acc, { index: 0, lastControlledUuid: undefined }, false);

  return {
    controlled: acc.controlled,
    orphans: acc.orphans,
    trackChanges: { present: acc.records.length > 0, records: acc.records },
    objectBlocks: extractObjectBlocks(nodes),
  };
}
