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
import { createOrderedDocumentXmlBuilder, toArray } from './xml-utils.js';
import { classifyTopLevelTables } from './tables.js';
import { extractParagraphText, isParagraphVanish } from './document.js';
import { classifyBodyDrawing, unwrapAlternateContent } from './body-drawings.js';
import { isDrawingRun, runsOf } from './header-footer-region.js';
import { pairRunOrder } from './header-footer-run-order.js';
import { wrapBlobParagraphWithAnchor } from './object-anchor.js';
import { stripAlternateContentFallback } from './alternate-content.js';
import { resolveHiddenTxbxContentNodes } from './body-text-box-visibility.js';
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
// `hiddenSubtrees` (#515, ADR-087) is the set of `w:txbxContent` boundary
// nodes — identity-matched, produced by resolveHiddenTxbxContentNodes — this
// walk must treat as opaque; see transformChildren's pass-through branch.
function transformInteriorParagraphs(
  node: ObjectBlobNode,
  hiddenSubtrees: ReadonlySet<ObjectBlobNode>
): InteriorTransformResult {
  const tag = tagOf(node);
  if (!tag) return { node, interiorTexts: [] };
  const value = node[tag];
  if (!isBlobNodeArray(value)) return { node, interiorTexts: [] };
  const { children, interiorTexts } = transformChildren(value, hiddenSubtrees);
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
function transformChildren(
  children: readonly ObjectBlobNode[],
  hiddenSubtrees: ReadonlySet<ObjectBlobNode>
): ChildrenTransformResult {
  const newChildren: ObjectBlobNode[] = [];
  const interiorTexts: CapturedObjectText[] = [];
  for (const child of children) {
    // #515: a hidden w:txbxContent boundary is opaque — pushed through by
    // the SAME reference (provably serialization-unaffected), contributing
    // no interiorTexts, never recursed into. Checked BEFORE the 'w:p' check
    // since a text box's host paragraph itself can never be a boundary, but
    // this branch must still win over any nested w:p the boundary contains.
    if (hiddenSubtrees.has(child)) {
      newChildren.push(child);
      continue;
    }
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
    const transformed = transformInteriorParagraphs(child, hiddenSubtrees);
    newChildren.push(transformed.node);
    interiorTexts.push(...transformed.interiorTexts);
  }
  return { children: newChildren, interiorTexts };
}

/** The public entry point for the interior-paragraph anchor walk (#515,
 * ADR-087): both {@link buildTableObject} and (a later task)
 * {@link buildTextBoxObject} call this, never the two private inner
 * functions directly. `hiddenSubtrees` defaults to an empty set — a no-op —
 * so every EXISTING call site (buildTableObject's own
 * `anchorInteriorParagraphs(normalized)`) compiles and behaves byte-for-byte
 * unchanged with zero edits. */
export function anchorInteriorParagraphs(
  root: ObjectBlobNode,
  hiddenSubtrees: ReadonlySet<ObjectBlobNode> = new Set()
): InteriorTransformResult {
  return transformInteriorParagraphs(root, hiddenSubtrees);
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
  // #517: normalize mc:AlternateContent to its mc:Choice branch BEFORE
  // walking for interior paragraphs and dimensions, exactly like
  // buildTextBoxObject below — a table cell can embed its own drawing (e.g.
  // a logo or a nested text box) wrapped in mc:AlternateContent, and the
  // depth-agnostic w:p walk in anchorInteriorParagraphs would otherwise find
  // w:p nodes in BOTH the Choice and the stale mc:Fallback (VML) branch,
  // doubling interiorTexts.
  const normalized = stripAlternateContentFallback(tableNode);
  const dims = tableDimensions(normalized);
  const anchored = anchorInteriorParagraphs(normalized);
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

type TextBoxClassification = Extract<BodyDrawingClassification, { kind: 'textBox' }>;

/** One drawing-bearing run's classification, paired with the run itself (post
 *  unwrapAlternateContent) — the run is kept so a textBox hit can be searched
 *  for its own interior content (hidden-text-box detection below) without a
 *  second runsOf() walk. */
interface DrawingRunEntry {
  readonly run: Record<string, unknown>;
  readonly classification: BodyDrawingClassification;
}

// Every grouped-mode run living inside an `mc:Fallback` subtree of `raw`
// (#515 review, CRITICAL). The captured blob has its `mc:Fallback` branches
// spliced out by stripAlternateContentFallback before the anchor walk sees
// it, so a Fallback run classified here would contribute a hidden flag with
// no surviving `w:txbxContent` boundary to correlate against —
// resolveHiddenTxbxContentNodes' count guard then fails closed and
// suppresses the VISIBLE mc:Choice box's interior text entirely.
//
// This only bites when `mc:AlternateContent` sits at BLOCK level, wrapping
// whole `w:r` elements in each branch (`w:p > mc:AlternateContent >
// mc:Choice > w:r`); the run-level shape Word normally emits
// (`w:r > mc:AlternateContent > mc:Choice > w:drawing`) puts no `w:r` inside
// the Fallback at all and was never affected. Both shapes are pinned in
// body-objects.test.ts.
//
// Reuses `runsOf` on each Fallback subtree rather than re-implementing
// collectRunsAndFields' traversal, so the two can never drift.
//
// On the reference-identity of this Set (#636 review): `runsOf` returns raw
// `w:r` element objects by reference, but `pushTerminalRun` re-wraps every
// `w:fldSimple` under a FRESH `{ 'w:fldSimple': element }` object per call —
// so a field piece collected here is never reference-equal to the one the
// classification loop below sees, and `fallbackRuns.has(...)` misses it.
// That miss is inert, not tolerated: the loop's own `isDrawingRun` gate is
// `'w:drawing' in run || 'w:pict' in run`, and a field piece's only key is
// `w:fldSimple` (`unwrapAlternateContent` returns it unchanged, having no
// `mc:AlternateContent` key), so a field piece can never become a
// DrawingRunEntry by either route. The exclusion set only has to be exact
// for runs that CAN classify as drawings, and those are raw `w:r` objects
// carried by reference. If `isDrawingRun` ever widens to accept a field
// piece, this Set must switch to a normalized key first — see
// `runOrderKey` in header-footer-region.ts, which unwraps for exactly this
// reason.
function collectFallbackRuns(value: unknown): ReadonlySet<Record<string, unknown>> {
  const found = new Set<Record<string, unknown>>();
  collectFallbackRunsInto(value, found);
  return found;
}

// Every run inside one `mc:Fallback` value — grouped mode may hold either a
// single node or an array of them, hence toArray.
function addFallbackSubtreeRuns(child: unknown, acc: Set<Record<string, unknown>>): void {
  const branches = toArray<Record<string, unknown>>(
    child as readonly Record<string, unknown>[] | undefined
  );
  for (const branch of branches) {
    for (const run of runsOf(branch)) acc.add(run);
  }
}

function collectFallbackRunsInto(value: unknown, acc: Set<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFallbackRunsInto(item, acc);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'mc:Fallback') {
      addFallbackSubtreeRuns(child, acc);
      continue;
    }
    collectFallbackRunsInto(child, acc);
  }
}

// EVERY drawing-bearing run is classified — never just the first — so a
// paragraph carrying more than one separate drawing (rare — Word normally
// puts one drawing per paragraph) never loses one to the other in the
// `dropped` accounting. FIXED (#515): two SEPARATE text boxes in ONE host
// paragraph are now fully handled — collectParagraphDrawing decides
// visibility PER text-box entry (`entries.filter`, one correlated
// hiddenFlag per box) rather than from the first box alone, so a hidden box
// never leaks its interior text (privacy) and a visible box is never
// suppressed just because another box in the same paragraph is hidden
// (no-suppression). The whole host paragraph still round-trips
// byte-identical either way (decision 1's opaque-blob capture); this only
// affects which interior paragraphs get an SDT anchor + objectText leaf.
//
// `paragraphNode` (#515 review, CRITICAL) is the SAME paragraph's own
// preserveOrder-mode `ObjectBlobNode` (body-order.ts's `paragraphBlobs[i]`)
// — a plain `runsOf(raw)` walk only preserves relative order among SAME-tag
// siblings of `raw`'s grouped-mode tree (a w:r wrapped in w:hyperlink/
// w:ins/w:del sorts to the END, after every un-wrapped w:r, regardless of
// where it truly sits), which desyncs from resolveHiddenTxbxContentNodes'
// TRUE-document-order `w:txbxContent` boundaries and can pair a hidden box's
// flag onto a visible box's boundary (or vice versa) — see
// body-text-box-visibility.ts. Pairing `raw` against `paragraphNode`'s own
// true-order children (`pairRunOrder`, header-footer-run-order.ts) recovers
// the correct order `runsOf`'s optional `order` param restores. Falls back
// to unordered `runsOf(raw)` only when no paragraphNode is available (never
// true for a real caller — every rawParagraphs entry has an index-aligned
// paragraphBlobs entry, body-order.test.ts's own pinned invariant — kept as
// a total, non-throwing fallback rather than an unreachable assertion).
function classifyParagraphDrawings(
  raw: Record<string, unknown>,
  paragraphNode: ObjectBlobNode | undefined
): readonly DrawingRunEntry[] {
  const order = paragraphNode ? pairRunOrder(raw, childrenOf(paragraphNode)) : undefined;
  const fallbackRuns = collectFallbackRuns(raw);
  const entries: DrawingRunEntry[] = [];
  for (const run of runsOf(raw, order)) {
    if (fallbackRuns.has(run)) continue;
    const unwrapped = unwrapAlternateContent(run);
    if (isDrawingRun(unwrapped)) {
      entries.push({ run: unwrapped, classification: classifyBodyDrawing(unwrapped) });
    }
  }
  return entries;
}

function isTextBoxEntry(
  entry: DrawingRunEntry
): entry is DrawingRunEntry & { classification: TextBoxClassification } {
  return entry.classification.kind === 'textBox';
}

function isDroppedEntry(
  entry: DrawingRunEntry
): entry is DrawingRunEntry & { classification: DroppedDrawable } {
  return entry.classification.kind !== 'textBox';
}

// `hiddenFlags` (ADR-087) is one entry per textBox-classified DrawingRunEntry
// found in the host paragraph's `raw` (grouped-mode) tree, IN TRUE DOCUMENT
// ORDER — classifyParagraphDrawings now walks `raw` via a `pairRunOrder`
// side-table (#515 review, CRITICAL) rather than `raw`'s own grouped-mode
// traversal order, so this is genuinely the same order
// resolveHiddenTxbxContentNodes' `hostNode` walk finds its w:txbxContent
// boundaries in — not merely "same order raw's tree happens to iterate in",
// which silently diverges whenever a text-box run sits inside a
// differently-tagged wrapper (w:hyperlink, w:ins/w:del) next to plain w:r
// siblings. The array MUST still be count-correct (one entry per boundary in
// the blob) or every boundary fails closed as hidden. collectParagraphDrawing
// supplies one real, per-box flag for every textBox entry in the paragraph
// (mapping the existing isHiddenTextBox check over each), so a hidden box's
// interior stays opaque (no objectText leaf) while a co-occurring visible
// box in the same paragraph is still anchored normally.
function buildTextBoxObject(
  hostBlob: readonly ObjectBlobNode[],
  classification: TextBoxClassification,
  hiddenFlags: readonly boolean[]
): CapturedBodyObject | undefined {
  const hostNode = hostBlob[0];
  if (!hostNode) return undefined;
  // #517: normalize mc:AlternateContent to its mc:Choice branch BEFORE
  // walking for interior paragraphs — otherwise anchorInteriorParagraphs's
  // depth-agnostic w:p walk finds w:p nodes in BOTH the Choice and the
  // stale mc:Fallback (VML) branch, doubling interiorTexts and letting an
  // interior text edit diverge from a fallback nobody edited.
  const normalized = stripAlternateContentFallback(hostNode);
  const hiddenSet = resolveHiddenTxbxContentNodes(normalized, hiddenFlags);
  const anchored = anchorInteriorParagraphs(normalized, hiddenSet);
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

function findInAny(items: readonly unknown[], tag: string): Record<string, unknown> | undefined {
  for (const item of items) {
    const found = findFirstDescendant(item, tag);
    if (found) return found;
  }
  return undefined;
}

// Depth-agnostic search for the first descendant keyed `tag`, regardless of
// nesting depth. Unlike document.ts's collectRuns — which intentionally
// treats the FIRST w:r it meets as a terminal leaf run and never looks
// inside it — a text box's own txbxContent interior paragraphs sit several
// levels INSIDE the host's drawing-bearing w:r, so reaching them needs a walk
// that does not stop there.
function findFirstDescendant(value: unknown, tag: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return findInAny(value, tag);
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const match = record[tag];
  if (match !== null && typeof match === 'object') return match as Record<string, unknown>;
  return findInAny(Object.values(record), tag);
}

// A text box's own txbxContent interior paragraphs (DrawingML wps:txbx and
// VML v:textbox both nest content under this same w:txbxContent tag).
function txbxContentParagraphs(
  drawingRun: Record<string, unknown>
): readonly Record<string, unknown>[] {
  const content = findFirstDescendant(drawingRun, 'w:txbxContent');
  if (!content) return [];
  return toArray<Record<string, unknown>>(
    content['w:p'] as readonly Record<string, unknown>[] | undefined
  );
}

// Evidence-based hidden check, mirroring tables.ts's classifyTable exactly:
// no text-bearing interior paragraph → not hidden (an empty or graphic-only
// text box has nothing to hide, even if some paragraph is technically
// vanish); every text-bearing interior paragraph vanish → hidden.
function isTextBoxInteriorHidden(drawingRun: Record<string, unknown>, styleMap: StyleMap): boolean {
  const evidence = txbxContentParagraphs(drawingRun).filter(
    (p) => extractParagraphText(p).trim().length > 0
  );
  return evidence.length > 0 && evidence.every((p) => isParagraphVanish(p, styleMap));
}

// A captured text box that is fully hidden — via its HOST paragraph mark/
// style (isParagraphVanish on `raw`, ADR-038 parity) OR every text-bearing
// interior txbxContent paragraph being vanish (isTextBoxInteriorHidden) — is
// retained out-of-band exactly like a hidden table: never surfaced as a
// visible `object` node, and never counted in `dropped` either — nothing was
// lost, the author intentionally hid it.
function isHiddenTextBox(
  raw: Record<string, unknown>,
  drawingRun: Record<string, unknown>,
  styleMap: StyleMap
): boolean {
  return isParagraphVanish(raw, styleMap) || isTextBoxInteriorHidden(drawingRun, styleMap);
}

// One paragraph's worth of drawing extraction: at most one object (built
// from the first VISIBLE textBox entry's classification, if any text box is
// visible) plus every non-textBox classification collected as its own
// dropped entry. Returns fresh data rather than mutating a shared
// accumulator — mirrors transformChildren's own {children, interiorTexts}
// return-shape above.
interface ParagraphDrawingResult {
  readonly object?: CapturedParagraphObject;
  readonly dropped: readonly DroppedDrawable[];
}

// #515: EVERY textBox entry is evaluated (`entries.filter`, not the old
// `.find`), so a host paragraph carrying two or more SEPARATE text boxes
// gets one correlated hidden flag per box — the exact count
// resolveHiddenTxbxContentNodes needs to match the blob's real
// w:txbxContent boundary count, instead of a single flag whose count
// silently mismatched (2 boundaries vs. 1 flag) and fell back to the
// fail-closed "suppress everything" guard.
function collectParagraphDrawing(
  paragraphBlobs: readonly (readonly ObjectBlobNode[])[],
  raw: Record<string, unknown>,
  paragraphIndex: number,
  styleMap: StyleMap
): ParagraphDrawingResult {
  const blob = paragraphBlobs[paragraphIndex];
  const entries = classifyParagraphDrawings(raw, blob?.[0]);
  const textBoxEntries = entries.filter(isTextBoxEntry);
  const dropped = entries.filter(isDroppedEntry).map((e) => e.classification);
  if (textBoxEntries.length === 0) {
    return { dropped };
  }
  const hiddenFlags = textBoxEntries.map((entry) => isHiddenTextBox(raw, entry.run, styleMap));
  const visibleIndex = hiddenFlags.findIndex((hidden) => !hidden);
  // Every text box in the host paragraph is hidden: no object captures the
  // blob, so a co-occurring non-textBox drawable (chart/smartArt/OLE/image)
  // is preserved nowhere and would be silently lost — still report it as
  // dropped. The one exception: when the HOST paragraph itself is vanish,
  // that drawable is intentionally hidden too, so drop nothing (ADR-072
  // decision 9's no-silent-loss posture only covers genuinely omitted
  // content). Unchanged from the pre-#515 branch, now correctly decided
  // over ALL boxes instead of just the first.
  if (visibleIndex === -1) {
    return { dropped: isParagraphVanish(raw, styleMap) ? [] : dropped };
  }
  // Shared kind/floating/generation metadata comes from the FIRST VISIBLE
  // entry — a deliberate, documented behavior change from the old
  // first-entry-regardless-of-visibility pick (ADR-087). Bounds-guarded via
  // the `findIndex` result rather than a non-null assertion.
  const chosen = textBoxEntries[visibleIndex];
  if (!chosen) {
    return { dropped };
  }
  const object = blob ? buildTextBoxObject(blob, chosen.classification, hiddenFlags) : undefined;
  return object ? { object: { paragraphIndex, object }, dropped: [] } : { dropped: [] };
}

function extractDrawingObjects(
  paragraphBlobs: readonly (readonly ObjectBlobNode[])[],
  rawParagraphs: readonly Record<string, unknown>[],
  styleMap: StyleMap
): DrawingExtractionResult {
  const paragraphObjects: CapturedParagraphObject[] = [];
  const dropped: DroppedDrawable[] = [];
  rawParagraphs.forEach((raw, paragraphIndex) => {
    const result = collectParagraphDrawing(paragraphBlobs, raw, paragraphIndex, styleMap);
    if (result.object) paragraphObjects.push(result.object);
    dropped.push(...result.dropped);
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
    rawParagraphs,
    styleMap
  );
  return { tableObjects, paragraphObjects, dropped };
}
