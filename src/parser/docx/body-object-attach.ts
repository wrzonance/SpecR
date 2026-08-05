// Bridges body-objects.ts's captured-object result to buildTree's attachment
// params (#300, ADR-072): converts each CapturedBodyObject into the `object`
// SpecNode + `objectText` leaves buildTree actually attaches, and supplies the
// raw grouped-mode body paragraphs extractBodyObjects needs. Kept out of
// index.ts (orchestration only) so runPipeline stays a short, readable wire-up.

import { v4 as uuidv4 } from 'uuid';
import { createDocumentXmlParser, toArray } from './xml-utils.js';
import { extractBodyObjects } from './body-objects.js';
import { computeBodyOrder } from './body-order.js';
import type {
  CapturedBodyObject,
  CapturedObjectText,
  CapturedParagraphObject,
  CapturedTableObject,
  DroppedDrawable,
} from './body-objects.js';
import type { StyleMap } from './types.js';
import type { ObjectMeta, SpecNode, ParseWarning } from '../../ast/index.js';

// Mirrors document.ts's own body['w:p'] extraction (same parser config): body-objects.ts's
// drawing scanner needs the RAW grouped-mode paragraph nodes (w:drawing/w:pict runs
// document.ts's own typed DocxParagraph parse discards), index-aligned with parseDocument's
// own output — same XML, same tag list, same array order.
const rawBodyParagraphParser = createDocumentXmlParser(['w:p', 'w:r', 'w:hyperlink']);

function parseRawBodyParagraphs(documentXml: string): readonly Record<string, unknown>[] {
  const parsed = rawBodyParagraphParser.parse(documentXml) as Record<string, unknown>;
  const doc = parsed['w:document'] as Record<string, unknown> | undefined;
  const body = doc?.['w:body'] as Record<string, unknown> | undefined;
  return toArray<Record<string, unknown>>(
    body?.['w:p'] as readonly Record<string, unknown>[] | undefined
  );
}

// #650: vanishCharStyleIds is persisted as a SORTED array — never a Set — so
// the JSONB column and fixture snapshots serialize deterministically
// regardless of the StyleMap's own (unordered) iteration order.
//
// byCodeUnit, NOT `localeCompare`: without an explicit locale the latter
// follows the HOST's default collation, so the same styles.xml would persist
// a different array order on a machine with a different locale — defeating
// the determinism this sort exists for, in a value written to JSONB and
// compared across environments. A bare `.sort()` would be equally
// deterministic but trips the repo's `sonarjs/no-alphabetical-sort` rule,
// which requires an explicit comparator; spelling the code-unit comparison
// out satisfies both that rule and cross-host reproducibility. Style IDs are
// opaque OOXML identifiers, never presented to a user, so locale-aware
// alphabetical ordering has no value here. Omitted
// entirely when empty, mirroring rows/columns' exactOptional-omission
// convention above: an absent key and an empty array are fully
// interchangeable (ObjectMetaSchema's own doc comment), so a table/text-box
// with no style-vanished runs round-trips byte-identical to today's rows.
const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

function toObjectMeta(captured: CapturedBodyObject): ObjectMeta {
  return {
    kind: captured.kind,
    floating: captured.floating,
    generation: captured.generation,
    ...(captured.rows !== undefined ? { rows: captured.rows } : {}),
    ...(captured.columns !== undefined ? { columns: captured.columns } : {}),
    ...(captured.vanishCharStyleIds.size > 0
      ? { vanishCharStyleIds: [...captured.vanishCharStyleIds].sort(byCodeUnit) }
      : {}),
    blob: [...captured.blob],
  };
}

// The objectText leaf's id is the SAME uuid baked into the parent object's blob via
// wrapBlobParagraphWithAnchor (object-anchor.ts) — the sole round-trip locator, never a
// freshly generated one; there is no separate blobPath/index field anywhere in this model.
function toObjectTextNode(text: CapturedObjectText): SpecNode {
  return { id: text.id, type: 'objectText', text: text.text, children: [], meta: {} };
}

function toObjectNode(captured: CapturedBodyObject): SpecNode {
  return {
    id: uuidv4(),
    type: 'object',
    text: captured.kind === 'table' ? 'Table' : 'Text Box',
    children: captured.interiorTexts.map(toObjectTextNode),
    meta: { object: toObjectMeta(captured) },
  };
}

interface AttachmentMap {
  readonly beforeFirst: readonly SpecNode[];
  readonly byIndex: ReadonlyMap<number, readonly SpecNode[]>;
}

function attachAt(byIndex: Map<number, SpecNode[]>, index: number, node: SpecNode): void {
  const existing = byIndex.get(index);
  if (existing) existing.push(node);
  else byIndex.set(index, [node]);
}

// Builds buildTree's two attachment inputs from the two captured-object species.
// Paragraph (text box) objects attach FIRST, at their own paragraph index — when a
// table's precedingParagraphIndex collides with that same index (a table immediately
// follows a paragraph that itself hosts a drawing), the text box's content is authored
// strictly before the table in document order, so it must attach first at that key.
function buildAttachmentMap(
  tableObjects: readonly CapturedTableObject[],
  paragraphObjects: readonly CapturedParagraphObject[]
): AttachmentMap {
  const beforeFirst: SpecNode[] = [];
  const byIndex = new Map<number, SpecNode[]>();
  for (const p of paragraphObjects) attachAt(byIndex, p.paragraphIndex, toObjectNode(p.object));
  for (const t of tableObjects) {
    const node = toObjectNode(t.object);
    if (t.precedingParagraphIndex === undefined) beforeFirst.push(node);
    else attachAt(byIndex, t.precedingParagraphIndex, node);
  }
  return { beforeFirst, byIndex };
}

function bodyDrawingSkippedWarning(dropped: readonly DroppedDrawable[]): ParseWarning | undefined {
  if (dropped.length === 0) return undefined;
  const counts = new Map<DroppedDrawable['kind'], number>();
  for (const d of dropped) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  const detail = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ');
  return {
    type: 'body-drawing-skipped',
    suggestion: `${dropped.length} body drawing(s) skipped (${detail}) — not yet modeled into the spec tree`,
  };
}

export interface BodyObjectAttachment {
  readonly objectsBeforeFirst: readonly SpecNode[];
  readonly objectsByPrecedingIndex: ReadonlyMap<number, readonly SpecNode[]>;
  readonly warning?: ParseWarning;
}

/**
 * Captures every body-level table/text box in `documentXml` and converts the
 * result into buildTree's two attachment params, plus (at most) one
 * `body-drawing-skipped` warning for whatever was out-of-scope and dropped
 * (#300, ADR-072). Never throws on a single unrecognized shape or an empty
 * table/text box — only malformed upstream XML (body-order.ts's own
 * ParserError) can propagate out.
 */
export function captureBodyObjectsForTree(
  documentXml: string,
  styleMap: StyleMap
): BodyObjectAttachment {
  const bodyOrder = computeBodyOrder(documentXml);
  const rawParagraphs = parseRawBodyParagraphs(documentXml);
  const { tableObjects, paragraphObjects, dropped } = extractBodyObjects(
    bodyOrder,
    rawParagraphs,
    styleMap
  );
  const { beforeFirst, byIndex } = buildAttachmentMap(tableObjects, paragraphObjects);
  const warning = bodyDrawingSkippedWarning(dropped);
  return {
    objectsBeforeFirst: beforeFirst,
    objectsByPrecedingIndex: byIndex,
    ...(warning ? { warning } : {}),
  };
}
