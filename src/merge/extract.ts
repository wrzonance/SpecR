import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { UUID_TAG_PREFIX } from '../ast/index.js';
import { MergeError } from './error.js';
import { fingerprintBlob } from './object-fingerprint.js';
import type { ExtractResult, ExtractedObjectBlock, TrackChangeRecord } from './types.js';
import type { ObjectBlobNode } from '../ast/index.js';
// #648/ADR-092: a narrow, deliberate exception to module-boundaries.md's
// "merge/ knows nothing about parsing" prose line — hasRunVanish is the
// SINGLE ST_OnOff-aware vanish predicate shared by object capture
// (body-objects.ts) and object-blob edit rewrite (object-blob-edit.ts); a
// second copy here would reintroduce the exact capture/rewrite drift
// ADR-092 closed. Reached through the parser's own barrel (parser/index.ts),
// per the repo's sibling-barrel-only import rule.
//
// The barrel does transitively load parser/pdf/index.ts's static pdfjs-dist /
// unpdf / tesseract.js imports (~+370ms, ~+290MB RSS on a cold graph), so this
// line was reviewed as a possible cold-start regression and deliberately kept:
// every production path that reaches merge/ ALREADY loads parser/index.js in
// the same file — src/api/diff.ts imports assertDocxSafe one line above its
// ../merge/index.js import, as does src/mcp/handlers.ts — and no merge-only
// worker, script, or CLI exists. Net production cost is therefore zero; the
// only module graph that grows is merge/extract.test.ts (31 tests, ~1.4s).
// Deep-importing ../parser/docx/body-objects.js instead would trade that zero
// for a strictly deeper violation of the same module-boundaries.md rule, and
// relocating hasRunVanish is what ADR-092 exists to prevent.
import { hasRunVanish } from '../parser/index.js';

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
// '#text' → string, ':@' → attribute record. This is the SAME runtime shape
// as ast/object-schemas.ts's ObjectBlobNode (both describe fast-xml-parser's
// preserveOrder output), so extract.ts aliases it directly rather than
// keeping a second, duplicate node-shape definition — that alignment is
// also what lets hasRunVanish (which is typed against ObjectBlobNode) accept
// an extract.ts node with zero cross-boundary cast (#648).
type OrderedNode = ObjectBlobNode;

interface ParaContext {
  readonly uuid: string | undefined;
  readonly records: TrackChangeRecord[];
  /** shared reference to the top-level walk's controlled map — lets a
   *  text-box run (visitRunNode's w:drawing/w:pict branch) capture interior
   *  specr-uuid anchors without threading the whole ExtractAcc through. */
  readonly controlled: Map<string, string>;
  /** true once the walk has descended into a body-level object block
   *  (w:tbl/w:drawing/w:pict — OBJECT_BLOCK_TAGS). Object-interior paragraphs
   *  must match the AST's objectText, which already drops hidden runs
   *  (issue #641/ADR-092); the ordinary paragraph tier's KNOWN AMBIGUITY
   *  (a mixed hidden/visible paragraph is treated as visible — see
   *  document.test.ts near line 259) is deliberately untouched outside an
   *  object interior. See visibleText's use of this flag (#648). */
  readonly objectInterior: boolean;
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
  // ObjectBlobNode's `:@` is `Readonly<Record<string, string | number>> |
  // undefined` (an optional property, never nullable) — `typeof attrs !==
  // 'object'` alone already excludes `undefined` (whose typeof is
  // 'undefined'), so no separate null check or value cast is needed.
  if (typeof attrs !== 'object') return undefined;
  const value = attrs[name];
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
 * walk's. objectInterior is forced true (#648): this function is only ever
 * reached from visitRunNode's w:drawing/w:pict dispatch, i.e. a text-box
 * interior, which is object territory by construction.
 */
function collectDrawingAnchors(nodes: readonly OrderedNode[], ctx: ParaContext): void {
  const throwawayAcc: ExtractAcc = {
    controlled: ctx.controlled,
    orphans: [],
    records: ctx.records,
  };
  walkBlocks(
    nodes,
    undefined,
    throwawayAcc,
    { index: 0, lastControlledUuid: undefined },
    false,
    true
  );
}

/** Visible (post virtual-accept) text of paragraph content nodes, in order.
 *  Inside an object interior (ctx.objectInterior), a run whose w:vanish is
 *  enabled (hasRunVanish, ST_OnOff-aware) is skipped — matching the object
 *  tier's objectText, which already drops the same runs (#641/ADR-092). This
 *  check is intentionally scoped to objectInterior only: the ordinary
 *  paragraph tier's KNOWN AMBIGUITY (a mixed hidden/visible paragraph reads
 *  as visible) is out of scope for #648 and must not change. */
function visibleText(nodes: readonly OrderedNode[], ctx: ParaContext): string {
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    if (ctx.objectInterior && hasRunVanish(node)) continue;
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
  inTable: boolean,
  objectInterior: boolean
): WalkState {
  const text = visibleText(childrenOf(node, 'w:p'), {
    uuid,
    records: acc.records,
    controlled: acc.controlled,
    objectInterior,
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

const OBJECT_BLOCK_TAGS = new Set(['w:tbl', 'w:drawing', 'w:pict']);

/** Walk block-level nodes in document order, tracking the enclosing sdt uuid,
 *  whether the walk has descended into a w:tbl (table cells never anchor),
 *  and whether it has descended into a body-level object block (#648 —
 *  OBJECT_BLOCK_TAGS: w:tbl/w:drawing/w:pict; a visibleText vanish-skip). */
function walkBlocks(
  nodes: readonly OrderedNode[],
  uuid: string | undefined,
  acc: ExtractAcc,
  state: WalkState,
  inTable: boolean,
  objectInterior: boolean
): WalkState {
  let s = state;
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    if (tag === 'w:sdt') {
      s = walkBlocks(
        childrenOf(node, tag),
        readSdtUuid(node) ?? uuid,
        acc,
        s,
        inTable,
        objectInterior
      );
    } else if (tag === 'w:p') {
      s = visitParagraph(node, uuid, acc, s, inTable, objectInterior);
    } else {
      // w:document, w:body, w:sdtContent, w:tbl, … — a w:tbl marks its whole
      // subtree as table-descended so its cell paragraphs stay anchorless;
      // any OBJECT_BLOCK_TAGS tag also marks its subtree as object-interior.
      s = walkBlocks(
        childrenOf(node, tag),
        uuid,
        acc,
        s,
        inTable || tag === 'w:tbl',
        objectInterior || OBJECT_BLOCK_TAGS.has(tag)
      );
    }
  }
  return s;
}

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
  blocks: ExtractedObjectBlock[],
  hostParagraph: OrderedNode | undefined
): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === '#text' || PROPERTY_TAGS.has(tag)) continue;
    const isObjectTag = OBJECT_BLOCK_TAGS.has(tag);
    if (isObjectTag && !inBlock) {
      blocks.push({
        interiorUuids: findInteriorUuids(childrenOf(node, tag)),
        fingerprint: fingerprintBlob([fingerprintRoot(node, tag, hostParagraph)]),
      });
    }
    walkObjectBlocks(
      childrenOf(node, tag),
      inBlock || isObjectTag,
      blocks,
      // A w:p becomes the host for any drawing run nested beneath it; deeper
      // non-paragraph nodes inherit it unchanged.
      tag === 'w:p' ? node : hostParagraph
    );
  }
}

/** Tags whose captured blob root is the HOST body `w:p`, not the tag itself. */
const PARAGRAPH_HOSTED_OBJECT_TAGS = new Set(['w:drawing', 'w:pict']);

/**
 * The node to fingerprint for a detected object block (#652) — it MUST be the
 * same root that capture stored as `ObjectMeta.blob[0]`, because diff.ts's
 * `detectObjectConflicts` fingerprints that stored blob directly and compares
 * the two hashes.
 *
 * The two capture kinds do not agree on what their root is
 * (parser/docx/body-objects.ts's module comment, "Two capture paths, one
 * shape"): a table's blob root is the `w:tbl` itself, so the matched tag IS
 * the root; a textBox/pict's blob root is the HOST body paragraph (`w:p`)
 * carrying the `w:r > w:drawing`/`w:pict` run, so the matched tag is one
 * wrapper layer BELOW the root.
 *
 * Fingerprinting the matched tag unconditionally is what made the table tier
 * symmetric (and every table test pass) while making the textBox tier compare
 * a bare `w:drawing(...)` shape against a stored `w:p(w:r(w:drawing(...)))`
 * shape — hashes that can never match, so every untouched round trip of a
 * text box reported a false `objectConflict`.
 *
 * Mirroring capture here (rather than changing capture to store the bare
 * node) keeps `buildObjectBlocks`'s re-emit contract intact: the generator
 * emits `blob[0]` as a body child, and a bare `w:drawing` is not a valid
 * block-level body child — it must sit inside a run inside a paragraph.
 */
function fingerprintRoot(
  node: OrderedNode,
  tag: string,
  hostParagraph: OrderedNode | undefined
): OrderedNode {
  if (!PARAGRAPH_HOSTED_OBJECT_TAGS.has(tag)) return node;
  // A drawing with no enclosing w:p is malformed OOXML; degrade to the bare
  // node rather than throwing — extract.ts never rejects a document it can
  // still partially read.
  return hostParagraph ?? node;
}

function extractObjectBlocks(nodes: readonly OrderedNode[]): ExtractedObjectBlock[] {
  const blocks: ExtractedObjectBlock[] = [];
  walkObjectBlocks(nodes, false, blocks, undefined);
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
  // Document root starts outside both a table and an object interior.
  walkBlocks(nodes, undefined, acc, { index: 0, lastControlledUuid: undefined }, false, false);

  return {
    controlled: acc.controlled,
    orphans: acc.orphans,
    trackChanges: { present: acc.records.length > 0, records: acc.records },
    objectBlocks: extractObjectBlocks(nodes),
  };
}
