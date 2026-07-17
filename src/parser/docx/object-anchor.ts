// SDT anchor injection for captured body-object blob paragraphs (#300,
// ADR-072 decision 4): wraps ONE captured paragraph node (an ObjectBlobNode
// already extracted from a table cell or text box interior) in the
// ObjectBlobNode-tree equivalent of generator/controls.ts's SdtBlock — the
// same `w:sdt > w:sdtPr > w:tag[w:val="specr-uuid-<uuid>"]` + `w:sdtContent`
// shape body paragraphs already get, so a body-object interior paragraph
// carries the exact same round-trip merge anchor as every other editable
// paragraph in the document (ADR-004).
//
// The UUID baked in here is the SOLE locator for the paragraph inside its
// parent's blob — there is no separate blobPath/index field anywhere in the
// AST (`objectText` carries only `{id, text}`, mirrored from
// generator/controls.ts's own paragraph-UUID convention). Finding the
// paragraph back inside the blob for a merge/edit means walking the blob for
// this `w:tag`, exactly as merge/extract.ts already does for ordinary body
// paragraphs (readUuidFromSdtPr).
//
// This module never imports from generator/ (module-boundary rule), so the
// SdtBlock shape is reproduced structurally as a preserveOrder node tree
// rather than shared by import — the two are cross-checked for an identical
// `w:tag` value in object-anchor.test.ts.

import { UUID_TAG_PREFIX } from '../../ast/index.js';
import type { ObjectBlobNode } from '../../ast/index.js';

/**
 * Wraps `paragraphNode` in a `w:sdt` anchor tagged with
 * `${UUID_TAG_PREFIX}${uuid}`, mirroring generator/controls.ts's SdtBlock
 * (`w:sdt > w:sdtPr > w:tag` + `w:sdtContent > paragraph`). Pure and total:
 * never mutates `paragraphNode`, never throws.
 */
export function wrapBlobParagraphWithAnchor(
  paragraphNode: ObjectBlobNode,
  uuid: string
): ObjectBlobNode {
  // `as ObjectBlobNode` here mirrors the established `compact(...) as
  // HeaderFooterRegion`-style narrowing this codebase already uses whenever
  // a hand-assembled record needs to be told it satisfies an ast/-defined
  // shape (header-footer-region.ts): ObjectBlobNode's index signature
  // (`Record<string, ObjectBlobNode[] | string>`) and its separately
  // intersected optional `':@'` attribute field can't both be checked
  // against one object literal at once — a known TS limitation for
  // "index-signature-plus-one-more-specific-key" intersections, not a sign
  // this literal is actually the wrong shape (it matches ObjectBlobNodeSchema
  // exactly; see object-anchor.test.ts's round-trip-through-the-builder
  // assertions).
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      { 'w:sdtContent': [paragraphNode] },
    ],
  } as ObjectBlobNode;
}
