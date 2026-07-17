// Body-level drawing classification (#300, ADR-072 decisions 9/10). A body
// paragraph's `w:drawing`/`w:pict` run that isn't a `w:tbl` is either a text
// box SpecR captures as an `object` (kind:'textBox' — see object-anchor.ts
// for the SDT anchor writer that makes its interior editable) or an
// out-of-scope drawable (chart, smartArt, OLE, image — body images get the
// same `object` treatment later, #511) that SpecR drops with a
// `body-drawing-skipped` warning rather than losing silently (ADR-068's
// no-silent-loss principle, carried forward).
//
// mc:AlternateContent (decision 9): Word wraps a modern text box (and other
// DrawingML content) in `<mc:AlternateContent><mc:Choice Requires="...">
// ...</mc:Choice><mc:Fallback>...</mc:Fallback></mc:AlternateContent>` so
// older readers fall back to an equivalent VML rendering. unwrapAlternateContent
// below always keeps the Choice branch and discards Fallback — re-emitting
// both would let an interior text edit diverge from a stale VML fallback. A
// VML-only source (no AlternateContent at all) is unaffected: it has no
// Choice/Fallback to unwrap and is classified on its own `w:pict` content
// directly.
//
// Reuses isDrawingRun/runsOf (header-footer-region.ts) and the pic:pic
// presence/absence discriminator (parseDrawingDescriptor,
// header-footer-images.ts) rather than hand-rolling a new run/drawing
// scanner — both already live in src/parser/docx/, so importing them is not
// a module-boundary violation. classifyBodyDrawing operates on a
// GROUPED-mode raw node (the same shape document.ts/tables.ts/
// header-footer-region.ts parse runs into) — classification here is
// presence/absence of known child tags, which needs no document-order data.

import { asRecord } from './xml-utils.js';
import { parseDrawingDescriptor } from './header-footer-images.js';

/** ADR-072 decisions 2/10: a body drawing's OOXML generation + recognized species. */
export type BodyDrawingClassification =
  | {
      readonly kind: 'textBox';
      readonly generation: 'drawingml' | 'vml';
      readonly floating: boolean;
    }
  | { readonly kind: 'chart' | 'smartArt' | 'ole' | 'image' | 'unknown' };

/**
 * Unwraps `mc:AlternateContent` to its `mc:Choice` content, discarding
 * `mc:Fallback` (decision 9). `node` is returned unchanged when it carries
 * no `mc:AlternateContent` at all — a VML-only run, or any run this parser
 * doesn't otherwise recognize — and also when `mc:AlternateContent` carries
 * no `mc:Choice` (malformed input; never a real Word output, but classifying
 * `node` itself rather than throwing keeps this function total). Pure,
 * never mutates `node`.
 *
 * KNOWN AMBIGUITY: OOXML permits multiple `mc:Choice` siblings (one per
 * `Requires` alternative); fast-xml-parser auto-arrayifies a genuinely
 * repeated sibling tag regardless of `isArray` (the same #306 trap
 * header-footer-images.ts documents for repeated `w:drawing`). Real Word
 * output emits exactly one `mc:Choice` + one `mc:Fallback`, so this is not
 * exercised by any known fixture; out of scope here.
 */
export function unwrapAlternateContent(node: Record<string, unknown>): Record<string, unknown> {
  const alternate = asRecord(node['mc:AlternateContent']);
  const choice = asRecord(alternate?.['mc:Choice']);
  return choice ?? node;
}

function drawingMlContainer(drawing: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(drawing['wp:inline']) ?? asRecord(drawing['wp:anchor']);
}

// decision 3: floating is wp:anchor-vs-wp:inline presence only — this never
// inspects the anchor's own offset/position geometry to guess where the
// object visually renders. Host-paragraph attachment (where this drawing's
// run physically sits in document order) is the ONLY placement SpecR
// records; a floating object's true visual position can diverge from its
// host paragraph and that divergence is never resolved here (KNOWN
// AMBIGUITY, decision 3 — see the pinned test in body-drawings.test.ts).
function isFloatingDrawingMl(drawing: Record<string, unknown>): boolean {
  return asRecord(drawing['wp:anchor']) !== undefined;
}

function graphicDataOf(container: Record<string, unknown>): Record<string, unknown> | undefined {
  const graphic = asRecord(container['a:graphic']);
  return asRecord(graphic?.['a:graphicData']);
}

// A wordprocessingShape's own wps:txbx child is the textbox discriminator —
// a plain wps:wsp with no wps:txbx (an ordinary autoshape) is NOT a text box
// and correctly falls through to 'unknown' below.
function isTextBoxGraphicData(graphicData: Record<string, unknown>): boolean {
  const wsp = asRecord(graphicData['wps:wsp']);
  return wsp !== undefined && 'wps:txbx' in wsp;
}

function classifyDrawingMlGraphicData(
  graphicData: Record<string, unknown> | undefined,
  floating: boolean
): BodyDrawingClassification {
  if (graphicData && isTextBoxGraphicData(graphicData)) {
    return { kind: 'textBox', generation: 'drawingml', floating };
  }
  if (graphicData && 'c:chart' in graphicData) return { kind: 'chart' };
  if (graphicData && 'dgm:relIds' in graphicData) return { kind: 'smartArt' };
  return { kind: 'unknown' };
}

function classifyDrawingMl(node: Record<string, unknown>): BodyDrawingClassification {
  const drawing = asRecord(node['w:drawing']);
  if (!drawing) return { kind: 'unknown' };
  // pic:pic presence/absence discriminator, reused as-is (header-footer-images.ts):
  // a resolvable drawing descriptor (rId + EMU size) only exists on a real
  // pic:pic image chain — chart/smartArt/textbox graphicData never produces one.
  if (parseDrawingDescriptor(node) !== undefined) return { kind: 'image' };
  const container = drawingMlContainer(drawing);
  const graphicData = container ? graphicDataOf(container) : undefined;
  return classifyDrawingMlGraphicData(graphicData, isFloatingDrawingMl(drawing));
}

function vmlShape(pict: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(pict['v:shape']);
}

// VML floating shapes carry `position:absolute` in their own style attribute
// (Word's standing convention — an inline VML shape has no position
// declaration at all); same host-paragraph-only caveat as
// isFloatingDrawingMl above.
function isFloatingVml(shape: Record<string, unknown>): boolean {
  const style = shape['@_style'];
  return typeof style === 'string' && style.includes('position:absolute');
}

function classifyVml(node: Record<string, unknown>): BodyDrawingClassification {
  const pict = asRecord(node['w:pict']);
  if (!pict) return { kind: 'unknown' };
  const shape = vmlShape(pict);
  if (!shape) return { kind: 'unknown' };
  if ('v:textbox' in shape) {
    return { kind: 'textBox', generation: 'vml', floating: isFloatingVml(shape) };
  }
  if ('v:imagedata' in shape) return { kind: 'image' };
  if ('o:OLEObject' in pict || 'o:OLEObject' in shape) return { kind: 'ole' };
  return { kind: 'unknown' };
}

/**
 * Classifies a body-level drawing-bearing node (a run already known to carry
 * `w:drawing` or `w:pict`, typically after {@link unwrapAlternateContent})
 * into a text box (recognized, in-scope) or one of the out-of-scope
 * drawable species SpecR drops with a warning. Pure, total, never throws —
 * a node with neither `w:drawing` nor `w:pict`, or one this walk otherwise
 * can't place, classifies as `{ kind: 'unknown' }` rather than failing.
 */
export function classifyBodyDrawing(node: Record<string, unknown>): BodyDrawingClassification {
  if ('w:drawing' in node) return classifyDrawingMl(node);
  if ('w:pict' in node) return classifyVml(node);
  return { kind: 'unknown' };
}
