// Parser-side header/footer inline-image extraction (#308 image fields,
// #487, ADR-068/069/071). Distinct from src/generator/header-footer-images.ts
// (AST `image` field -> docx `ImageRun`); this file walks the OTHER
// direction — raw OOXML `w:drawing` -> AST `image` field — and never
// renders anything. Two pure, total, never-throw functions:
//   parseDrawingDescriptor — structural walk (rId + EMU size + alt text),
//     before any byte resolution.
//   resolveDrawingImage — byte lookup + sniff + size-cap + field build,
//     mirroring header-footer-region.ts's own FieldResolution two-arm shape.
// Media bytes themselves are eagerly resolved elsewhere
// (header-footer-media-parts.ts, in the async extraction phase) and handed
// in here as a plain rId -> bytes lookup, so this module stays synchronous.

import { asRecord, compact, extractAttrStr } from './xml-utils.js';
import { sniffImageMediaType, MAX_IMAGE_BYTES } from '../../lib/image-media-type.js';
import type { PartialUnmodeled } from './header-footer-region.js';
import type { HeaderFooterVariant } from '../../ast/index.js';
import { RELS_UNREADABLE_REASON } from './header-footer-media-parts.js';
import type { HeaderFooterPartMedia } from './header-footer-media-parts.js';

// Local alias, structurally identical to header-footer-region.ts's own
// (unexported) HeaderFooterField derivation — re-derived here rather than
// imported so this file's only header-footer-region.ts dependency is the
// (already-exported) PartialUnmodeled type. TypeScript's structural typing
// makes the two interchangeable at every call site (both ultimately derive
// from the same ast/header-footer-schemas.ts shape).
type HeaderFooterRegion = NonNullable<HeaderFooterVariant['header']>;
type HeaderFooterCell = NonNullable<HeaderFooterRegion['left']>;
export type HeaderFooterField = NonNullable<HeaderFooterCell['content']>[number];

export interface DrawingDescriptor {
  readonly rId: string;
  readonly widthEmu: number;
  readonly heightEmu: number;
  readonly altText?: string;
}

// wp:inline and wp:anchor are both plain (non-array) objects under the
// existing partParser config (header-footer-region.ts's
// createDocumentXmlParser call site, isArray tags unchanged) — a w:drawing
// carries at most one of the two per ECMA-376 CT_Drawing, never both.
function drawingContainer(drawing: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(drawing['wp:inline']) ?? asRecord(drawing['wp:anchor']);
}

// wp:extent's cx/cy attributes carry NO namespace prefix of their own
// (ECMA-376 CT_PositiveSize2D), even though wp:extent — their parent
// element — does carry the wp: prefix: element names and attribute names
// are independently namespaced in XML. So this reads '@_cx'/'@_cy', not
// '@_wp:cx'/'@_wp:cy'. Missing/non-positive/unparseable cx or cy means "no
// decidable size" — the whole descriptor is dropped, not just the size.
// A valid EMU coordinate is a bare positive integer (ECMA-376
// ST_PositiveCoordinate). parseInt would silently accept suffix garbage
// ("914400px" -> 914400), modeling a malformed extent as a real size, so
// require a complete unsigned-integer match before converting; anything else
// (partial number, sign, exponent, whitespace, empty) is "no decidable size".
function positiveEmu(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = parseInt(raw, 10);
  return value > 0 ? value : undefined;
}

function extentEmu(
  container: Record<string, unknown>
): { readonly widthEmu: number; readonly heightEmu: number } | undefined {
  const extent = asRecord(container['wp:extent']);
  if (!extent) return undefined;
  const cx = positiveEmu(extractAttrStr(extent, '@_cx'));
  const cy = positiveEmu(extractAttrStr(extent, '@_cy'));
  if (cx === undefined || cy === undefined) return undefined;
  return { widthEmu: cx, heightEmu: cy };
}

// wp:docPr's descr/name attributes are likewise UNPREFIXED (ECMA-376
// CT_NonVisualDrawingProps) despite wp:docPr's own wp: element prefix —
// '@_descr'/'@_name', not '@_wp:descr'/'@_wp:name'. descr (the intended
// alt-text field) wins over name (a fallback identifier, e.g. Word's default
// "Picture 1") when both are present.
function altTextOf(container: Record<string, unknown>): string | undefined {
  const docPr = asRecord(container['wp:docPr']);
  if (!docPr) return undefined;
  const descr = extractAttrStr(docPr, '@_descr');
  if (descr !== '') return descr;
  const name = extractAttrStr(docPr, '@_name');
  return name === '' ? undefined : name;
}

// a:blip's embed relationship id IS fully prefixed ('@_r:embed') — unlike
// wp:extent/wp:docPr above, this attribute's OWN qualified name is r:embed
// (the "r" relationships namespace, not "a"), so fast-xml-parser's
// attributeNamePrefix preserves the r: prefix verbatim. A blip carrying only
// r:link (an external/linked image, no embedded part) has no r:embed and
// yields undefined here — deliberately unsupported: there is no embedded
// media-part rId to resolve. Also undefined when the graphicData has no
// pic:pic chain at all (chart/smartart/group-shape drawings, which
// genuinely lack pic:pic — not a defect in this walk).
function embedRId(container: Record<string, unknown>): string | undefined {
  const graphic = asRecord(container['a:graphic']);
  const graphicData = asRecord(graphic?.['a:graphicData']);
  const pic = asRecord(graphicData?.['pic:pic']);
  const blipFill = asRecord(pic?.['pic:blipFill']);
  const blip = asRecord(blipFill?.['a:blip']);
  const rId = blip ? extractAttrStr(blip, '@_r:embed') : '';
  return rId === '' ? undefined : rId;
}

/**
 * Structurally extract a `w:drawing` run's rId + EMU size + alt text —
 * before any byte resolution. Pure, total, never throws.
 *
 * `undefined` when: `run` carries no `w:drawing`; no `wp:inline`/`wp:anchor`
 * container; no `pic:pic` chain (chart/smartart/group-shape drawings) or no
 * resolvable `a:blip/@_r:embed` (`r:link`-only/external blips); or
 * `wp:extent`'s cx/cy is missing, non-positive, or unparseable.
 *
 * KNOWN AMBIGUITY (pre-existing, shared with #306's `isDrawingRun`
 * filtering): `w:drawing` is absent from every `isArrayTags` list in this
 * codebase. A single drawing parses as a plain object, but fast-xml-parser
 * auto-arrayifies a *repeated* sibling tag regardless of `isArray`, so a run
 * with two-or-more `w:drawing` children yields `run['w:drawing']` as an
 * array — which this function's `asRecord`-based walk cannot descend into
 * (an array has no `wp:inline`/`wp:anchor` property), so it returns
 * `undefined` for the whole run rather than resolving any of the drawings.
 * Registering `w:drawing` as an array tag and decomposing multiple
 * descriptors per run is out of scope here; see the pinned test below.
 */
export function parseDrawingDescriptor(
  run: Record<string, unknown>
): DrawingDescriptor | undefined {
  const drawing = asRecord(run['w:drawing']);
  if (!drawing) return undefined;
  const container = drawingContainer(drawing);
  if (!container) return undefined;
  const rId = embedRId(container);
  if (!rId) return undefined;
  const extent = extentEmu(container);
  if (!extent) return undefined;
  const altText = altTextOf(container);
  // Conditional spread over `compact(...) as DrawingDescriptor`: altText is the
  // only optional field, so omitting it when absent keeps the exact-optional
  // shape without a type assertion (project rule: no cross-boundary asserts).
  return {
    rId,
    widthEmu: extent.widthEmu,
    heightEmu: extent.heightEmu,
    ...(altText !== undefined ? { altText } : {}),
  };
}

/** Mirrors header-footer-region.ts's own (unexported) FieldResolution shape. */
export type DrawingResolution =
  | { readonly kind: 'field'; readonly field: HeaderFooterField }
  | { readonly kind: 'unmodeled'; readonly entry: PartialUnmodeled };

// Same `{ kind: 'image', detail: {...} }` unmodeled shape #306 already
// emits for an unresolvable drawing run (header-footer-region.ts's own
// pre-filter) — every failure arm below falls back to this, never a throw.
function unmodeledDrawing(run: Record<string, unknown>): DrawingResolution {
  return { kind: 'unmodeled', entry: { kind: 'image', detail: compact(run) } };
}

// #502: a `relsUnreadable` part means the part's own .rels file could not be
// read/parsed at all — every reference into it is unresolvable by
// construction, not merely a miss. Distinguished from a plain lookup miss
// (`unmodeledDrawing`, kind:'image') by carrying `rId`/`part`/`reason`, so
// header-footer-media-warnings.ts can attribute one capture-warning per
// damaged part instead of one generic "image content not modeled" per run.
function relsUnreadableEntry(rId: string, partPath: string): DrawingResolution {
  return {
    kind: 'unmodeled',
    entry: {
      kind: 'unresolvedReference',
      detail: compact({ rId, part: partPath, reason: RELS_UNREADABLE_REASON }),
    },
  };
}

/**
 * Resolve a `w:drawing` run to a modeled `image` field or an unmodeled
 * fallback entry (ADR-068: never fail capture). Pure, sync, never throws —
 * `partMedia` is a plain lookup, already resolved by the async extraction
 * phase (header-footer-media-parts.ts); no I/O happens here.
 *
 * Resolution order, first failure wins:
 *  1. no descriptor (see parseDrawingDescriptor) -> unmodeled (rels-index
 *     health is irrelevant to a non-pointer drawing)
 *  2. `partMedia.status === 'relsUnreadable'` (#502) -> unresolvedReference,
 *     carrying rId/part/reason — the part's own .rels file is damaged, so
 *     every reference into it is unresolvable by construction
 *  3. `partMedia.status === 'resolved'` but its `media`/rId lookup misses ->
 *     unmodeled
 *  4. bytes don't sniff to a supported type (#306 regression guard) -> unmodeled
 *  5. raw byte length exceeds MAX_IMAGE_BYTES, checked BEFORE base64 encoding
 *     and BEFORE HeaderFooterCompositionSchema.parse() ever sees the field
 *     (buildComposition) -> unmodeled
 *  6. success -> `image` field, imageMediaType always the SNIFFED type
 *     (never a caller/part-declared type), imageData a base64 encoding of
 *     the accepted bytes.
 */
export function resolveDrawingImage(
  run: Record<string, unknown>,
  partMedia: HeaderFooterPartMedia | undefined
): DrawingResolution {
  const descriptor = parseDrawingDescriptor(run);
  if (!descriptor) return unmodeledDrawing(run);
  if (partMedia?.status === 'relsUnreadable') {
    return relsUnreadableEntry(descriptor.rId, partMedia.partPath);
  }
  const bytes = partMedia?.status === 'resolved' ? partMedia.media.get(descriptor.rId) : undefined;
  if (!bytes) return unmodeledDrawing(run);
  const imageMediaType = sniffImageMediaType(bytes);
  if (!imageMediaType) return unmodeledDrawing(run);
  if (bytes.byteLength > MAX_IMAGE_BYTES) return unmodeledDrawing(run);
  const { altText } = descriptor;
  // Conditional spread over `compact(...) as HeaderFooterField`: altText is the
  // only optional field here (imageMediaType/widthEmu/heightEmu are all defined
  // by this point), so the explicit annotation + spread keeps the exact-optional
  // image variant without an assertion (project rule: no cross-boundary asserts).
  const field: HeaderFooterField = {
    kind: 'image',
    imageData: Buffer.from(bytes).toString('base64'),
    imageMediaType,
    widthEmu: descriptor.widthEmu,
    heightEmu: descriptor.heightEmu,
    ...(altText !== undefined ? { altText } : {}),
  };
  return { kind: 'field', field };
}
