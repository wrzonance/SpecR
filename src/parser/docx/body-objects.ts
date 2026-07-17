// Body object extraction orchestrator (#300, ADR-072): combines the two
// captured-object species — `w:tbl` tables (via bodyOrder.tables +
// tables.ts's hidden/visible classification, ADR-038 path untouched) and
// `w:drawing`/`w:pict` text boxes (via body-drawings.ts's classification) —
// into one pass over a document's body content. Every interior paragraph of
// a captured object gets an SDT round-trip anchor (object-anchor.ts) exactly
// like an ordinary body paragraph, and every out-of-scope drawable (chart,
// smartArt, OLE, image, unrecognized) is collected rather than silently
// dropped, so index.ts (a later task) can turn it into one
// `body-drawing-skipped` ParseWarning.
//
// Two capture paths, one shape: a table's own blob root is `w:tbl`, a text
// box's blob root is the HOST body paragraph (`w:p`) that carries the
// drawing run. `anchorInteriorParagraphs` below walks EITHER root's own
// CHILDREN (never the root itself) looking for nested `w:p` nodes — for a
// table that finds cell paragraphs several levels down (w:tr > w:tc > w:p);
// for a text box it finds the txbxContent's own paragraph(s) nested inside
// the drawing run, while correctly never mistaking the outer host paragraph
// itself for an interior leaf.

import { v4 as uuidv4 } from 'uuid';
import { createOrderedDocumentXmlBuilder } from './xml-utils.js';
import { classifyTopLevelTables } from './tables.js';
import { classifyBodyDrawing, unwrapAlternateContent } from './body-drawings.js';
import { isDrawingRun, runsOf } from './header-footer-region.js';
import { wrapBlobParagraphWithAnchor } from './object-anchor.js';
import type { ClassifiedTopLevelTable } from './tables.js';
import type { BodyDrawingClassification } from './body-drawings.js';
import type { BodyOrder, BodyOrderTable } from './body-order.js';
import type { StyleMap } from './types.js';
import type { ObjectBlobNode, ObjectKind, ObjectGeneration } from '../../ast/index.js';

/** One captured interior paragraph, ready to become an `objectText` SpecNode
 * leaf (a later task). `id` is the SAME uuid baked into the parent object's
 * `blob` via {@link wrapBlobParagraphWithAnchor} — the sole locator, no
 * separate blobPath/index field anywhere (object-anchor.ts). Never built for
 * an empty-text paragraph — see {@link transformChildren}'s inclusion check.
 */
export interface CapturedObjectText {
  readonly id: string;
  readonly text: string;
}

/** One captured `object` SpecNode's worth of data (a later task converts
 * this, plus a fresh uuid/label, into the actual SpecNode + its `objectText`
 * children). `blob` already carries every interior paragraph's SDT anchor —
 * it is the exact node tree the parent `object.meta.object.blob` will store.
 */
export interface CapturedBodyObject {
  readonly kind: ObjectKind;
  readonly floating: boolean;
  readonly generation: ObjectGeneration;
  readonly rows?: number;
  readonly columns?: number;
  readonly blob: readonly ObjectBlobNode[];
  readonly interiorTexts: readonly CapturedObjectText[];
}

/** An out-of-scope body drawable SpecR could not capture (ADR-072 decision
 * 10) — never silently lost, always collected here for the caller's single
 * `body-drawing-skipped` warning.
 */
export interface DroppedDrawable {
  readonly kind: 'chart' | 'smartArt' | 'ole' | 'image' | 'unknown';
}

export interface CapturedTableObject {
  readonly precedingParagraphIndex: number | undefined;
  readonly object: CapturedBodyObject;
}

export interface CapturedParagraphObject {
  readonly paragraphIndex: number;
  readonly object: CapturedBodyObject;
}

export interface BodyObjectExtractionResult {
  readonly tableObjects: readonly CapturedTableObject[];
  readonly paragraphObjects: readonly CapturedParagraphObject[];
  readonly dropped: readonly DroppedDrawable[];
}

// ─── ObjectBlobNode navigation (preserveOrder-mode, self-contained per the
// established per-module-helper pattern — see body-order.ts's own private
// tagOf/childrenOf) ──────────────────────────────────────────────────────

function tagOf(node: ObjectBlobNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

// Hand-written type guard, not a bare `Array.isArray` check: TS narrows
// `Array.isArray` over a `readonly ObjectBlobNode[] | string` union to
// `any[]` (lib.es5.d.ts limitation), which would leak an unsafe `any[]`
// into every caller. Mirrors body-order.ts's own isBlobNodeArray.
function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function childrenOf(node: ObjectBlobNode): readonly ObjectBlobNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const value = node[tag];
  return isBlobNodeArray(value) ? value : [];
}

function directChildrenByTag(node: ObjectBlobNode, tag: string): readonly ObjectBlobNode[] {
  return childrenOf(node).filter((child) => tagOf(child) === tag);
}

// ─── table dimensions ──────────────────────────────────────────────────────

function gridColumnCount(tableNode: ObjectBlobNode): number | undefined {
  const grid = directChildrenByTag(tableNode, 'w:tblGrid')[0];
  if (!grid) return undefined;
  const count = directChildrenByTag(grid, 'w:gridCol').length;
  return count > 0 ? count : undefined;
}

function maxRowCellCount(rows: readonly ObjectBlobNode[]): number | undefined {
  const max = Math.max(0, ...rows.map((row) => directChildrenByTag(row, 'w:tc').length));
  return max > 0 ? max : undefined;
}

interface TableDimensions {
  readonly rows?: number;
  readonly columns?: number;
}

function tableDimensions(tableNode: ObjectBlobNode): TableDimensions {
  const rowNodes = directChildrenByTag(tableNode, 'w:tr');
  const columns = gridColumnCount(tableNode) ?? maxRowCellCount(rowNodes);
  return {
    ...(rowNodes.length > 0 ? { rows: rowNodes.length } : {}),
    ...(columns !== undefined ? { columns } : {}),
  };
}

// ─── interior paragraph text + SDT anchoring ────────────────────────────────

// w:t is the ONLY text-bearing leaf a run ever carries (mirrors
// document.ts's extractRunText); walking every descendant regardless of
// wrapper (w:hyperlink, w:ins/w:del, w:sdt) reaches wrapped text the same
// way document.ts's collectRuns does, with no per-wrapper special-casing.
function collectText(children: readonly ObjectBlobNode[], acc: string[]): void {
  for (const child of children) {
    const tag = tagOf(child);
    if (tag === 'w:t') {
      const first = childrenOf(child)[0];
      const text = first ? first['#text'] : undefined;
      if (typeof text === 'string') acc.push(text);
      continue;
    }
    collectText(childrenOf(child), acc);
  }
}

function extractBlobText(node: ObjectBlobNode): string {
  const acc: string[] = [];
  collectText([node], acc);
  return acc.join('');
}

interface InteriorTransformResult {
  readonly node: ObjectBlobNode;
  readonly interiorTexts: readonly CapturedObjectText[];
}

interface ChildrenTransformResult {
  readonly children: readonly ObjectBlobNode[];
  readonly interiorTexts: readonly CapturedObjectText[];
}

// Rebuilds `node`'s OWN children (never re-checking `node` itself against
// `w:p` — that is what lets one recursive walk serve both a table root
// (`w:tbl`, never itself `w:p`) and a text box's host paragraph root
// (`w:p`, which must NOT be mistaken for one of its own interior leaves).
function transformInteriorParagraphs(node: ObjectBlobNode): InteriorTransformResult {
  const tag = tagOf(node);
  if (!tag) return { node, interiorTexts: [] };
  const value = node[tag];
  if (!isBlobNodeArray(value)) return { node, interiorTexts: [] };
  const { children, interiorTexts } = transformChildren(value);
  const attrs = node[':@'];
  // `as ObjectBlobNode` mirrors object-anchor.ts's own established narrowing
  // (see wrapBlobParagraphWithAnchor): ObjectBlobNode's index signature plus
  // its separately-intersected optional `:@` key can't both be checked
  // against one hand-assembled object literal at once — a known TS
  // limitation, not a sign this literal is the wrong shape.
  const rebuilt = (
    attrs !== undefined ? { [tag]: children, ':@': attrs } : { [tag]: children }
  ) as ObjectBlobNode;
  return { node: rebuilt, interiorTexts };
}

// An empty-text interior paragraph (a spacer cell, a blank txbxContent line)
// is left in the blob completely unanchored: object-anchor.test.ts's own
// "objectText non-emptiness precondition" pins this as THIS layer's job, not
// wrapBlobParagraphWithAnchor's — an anchor with no corresponding objectText
// leaf would be a dangling, never-reachable UUID.
function transformChildren(children: readonly ObjectBlobNode[]): ChildrenTransformResult {
  const newChildren: ObjectBlobNode[] = [];
  const interiorTexts: CapturedObjectText[] = [];
  for (const child of children) {
    if (tagOf(child) === 'w:p') {
      const text = extractBlobText(child);
      if (text.trim().length === 0) {
        newChildren.push(child);
        continue;
      }
      const id = uuidv4();
      newChildren.push(wrapBlobParagraphWithAnchor(child, id));
      interiorTexts.push({ id, text });
      continue;
    }
    const transformed = transformInteriorParagraphs(child);
    newChildren.push(transformed.node);
    interiorTexts.push(...transformed.interiorTexts);
  }
  return { children: newChildren, interiorTexts };
}

function anchorInteriorParagraphs(root: ObjectBlobNode): InteriorTransformResult {
  return transformInteriorParagraphs(root);
}

// ─── table capture ──────────────────────────────────────────────────────────

function classifyTableVisibility(
  blob: readonly ObjectBlobNode[],
  styleMap: StyleMap
): ClassifiedTopLevelTable | undefined {
  const tableXml = createOrderedDocumentXmlBuilder().build(blob);
  const wrapped = `<w:document><w:body>${tableXml}</w:body></w:document>`;
  return classifyTopLevelTables(wrapped, styleMap)[0];
}

function buildTableObject(blob: readonly ObjectBlobNode[]): CapturedBodyObject | undefined {
  const tableNode = blob[0];
  if (!tableNode) return undefined;
  const dims = tableDimensions(tableNode);
  const anchored = anchorInteriorParagraphs(tableNode);
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    ...dims,
    blob: [anchored.node],
    interiorTexts: anchored.interiorTexts,
  };
}

function extractTableObjects(
  tables: readonly BodyOrderTable[],
  styleMap: StyleMap
): readonly CapturedTableObject[] {
  const captured: CapturedTableObject[] = [];
  for (const table of tables) {
    const classification = classifyTableVisibility(table.blob, styleMap);
    if (!classification || classification.kind === 'hidden') continue;
    const object = buildTableObject(table.blob);
    if (object) captured.push({ precedingParagraphIndex: table.precedingParagraphIndex, object });
  }
  return captured;
}

// ─── drawing / text box capture ─────────────────────────────────────────────

// The FIRST drawing-bearing run (after unwrapAlternateContent) decides the
// whole paragraph's fate. KNOWN AMBIGUITY: a paragraph with two SEPARATE
// drawing runs (rare — Word normally puts one drawing per paragraph) is
// classified by its first drawing only; any second drawing round-trips
// silently inside the same captured blob rather than getting its own
// dropped/object entry.
function classifyParagraphDrawing(
  raw: Record<string, unknown>
): BodyDrawingClassification | undefined {
  for (const run of runsOf(raw)) {
    const unwrapped = unwrapAlternateContent(run);
    if (isDrawingRun(unwrapped)) return classifyBodyDrawing(unwrapped);
  }
  return undefined;
}

function buildTextBoxObject(
  hostBlob: readonly ObjectBlobNode[],
  classification: Extract<BodyDrawingClassification, { kind: 'textBox' }>
): CapturedBodyObject | undefined {
  const hostNode = hostBlob[0];
  if (!hostNode) return undefined;
  const anchored = anchorInteriorParagraphs(hostNode);
  return {
    kind: 'textBox',
    floating: classification.floating,
    generation: classification.generation,
    blob: [anchored.node],
    interiorTexts: anchored.interiorTexts,
  };
}

interface DrawingExtractionResult {
  readonly paragraphObjects: readonly CapturedParagraphObject[];
  readonly dropped: readonly DroppedDrawable[];
}

function extractDrawingObjects(
  paragraphBlobs: readonly (readonly ObjectBlobNode[])[],
  rawParagraphs: readonly Record<string, unknown>[]
): DrawingExtractionResult {
  const paragraphObjects: CapturedParagraphObject[] = [];
  const dropped: DroppedDrawable[] = [];
  rawParagraphs.forEach((raw, paragraphIndex) => {
    const classification = classifyParagraphDrawing(raw);
    if (!classification) return;
    if (classification.kind !== 'textBox') {
      dropped.push({ kind: classification.kind });
      return;
    }
    const blob = paragraphBlobs[paragraphIndex];
    const object = blob ? buildTextBoxObject(blob, classification) : undefined;
    if (object) paragraphObjects.push({ paragraphIndex, object });
  });
  return { paragraphObjects, dropped };
}

// ─── orchestration ──────────────────────────────────────────────────────────

/**
 * Captures every body-level table and text box in one pass (#300, ADR-072):
 * `bodyOrder.tables` for tables (independently document-ordered against
 * `rawParagraphs` via `precedingParagraphIndex`) and `rawParagraphs` itself
 * for drawings (a text box attaches to its OWN paragraph index directly — no
 * BodyOrder entry needed, it is already an ordered member of that array).
 * Never throws on a single unrecognized shape or an empty table/text box —
 * only a malformed upstream XML re-parse (tables.ts's own ParserError) can
 * propagate out of this function.
 */
export function extractBodyObjects(
  bodyOrder: BodyOrder,
  rawParagraphs: readonly Record<string, unknown>[],
  styleMap: StyleMap
): BodyObjectExtractionResult {
  const tableObjects = extractTableObjects(bodyOrder.tables, styleMap);
  const { paragraphObjects, dropped } = extractDrawingObjects(
    bodyOrder.paragraphBlobs,
    rawParagraphs
  );
  return { tableObjects, paragraphObjects, dropped };
}
