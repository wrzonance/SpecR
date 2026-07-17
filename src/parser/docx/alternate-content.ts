// Recursive preserveOrder-mode `mc:AlternateContent` normalizer for the
// captured body-object blob path (#517). body-drawings.ts's own
// unwrapAlternateContent unwraps ONE grouped-mode node's own top-level
// mc:AlternateContent for CLASSIFICATION purposes (does this run carry a
// text box, chart, image...?) — a shallow, single-level substitution. This
// module solves a different problem: a captured object's blob
// (ObjectBlobNode, preserveOrder-mode) can carry mc:AlternateContent
// anywhere in its interior, and every occurrence must be normalized to its
// mc:Choice content before the blob is re-emitted (generator/object-block.ts),
// or the generator would round-trip BOTH the Choice and the stale Fallback
// branch side by side — letting an interior text edit (#300 objectText)
// diverge from a VML fallback nobody edited. Deliberately NOT shared with
// unwrapAlternateContent: different node shape (preserveOrder vs grouped),
// different scope (recursive normalize-the-whole-tree vs shallow
// classify-this-one-run), and this one SPLICES the Choice's children into
// the parent's children array in place of the single AlternateContent
// child — unwrapAlternateContent's grouped-mode "just substitute the node"
// shape has no need to do that.

import type { ObjectBlobNode } from '../../ast/index.js';

// ─── ObjectBlobNode navigation (preserveOrder-mode; self-contained per the
// established per-module-helper pattern — see generator/object-block.ts and
// body-objects.ts/body-order.ts's own private tagOf/childrenOf) ────────────

function tagOf(node: ObjectBlobNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

// Hand-written type guard, not a bare `Array.isArray` check: TS narrows
// `Array.isArray` over a `readonly ObjectBlobNode[] | string` union to
// `any[]` (lib.es5.d.ts limitation), which would leak an unsafe `any[]` into
// every caller.
function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function childrenOf(node: ObjectBlobNode): readonly ObjectBlobNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const value = node[tag];
  return isBlobNodeArray(value) ? value : [];
}

function isAlternateContentNode(node: ObjectBlobNode): boolean {
  return tagOf(node) === 'mc:AlternateContent';
}

// KNOWN AMBIGUITY: OOXML technically permits multiple mc:Choice siblings
// (one per Requires alternative) inside one mc:AlternateContent; real Word
// output emits exactly one Choice + one Fallback, so this is not exercised
// by any known fixture (same caveat body-drawings.ts's own
// unwrapAlternateContent documents for the identical trap). The FIRST
// mc:Choice found wins; any further sibling Choice is discarded silently,
// alongside the Fallback.
function choiceChildren(node: ObjectBlobNode): readonly ObjectBlobNode[] | undefined {
  const choice = childrenOf(node).find((child) => tagOf(child) === 'mc:Choice');
  return choice ? childrenOf(choice) : undefined;
}

// Expands one child into zero-or-more replacement children for its parent's
// rebuilt array: an ordinary child recurses and stays exactly one child; an
// `mc:AlternateContent` child is spliced out for its (recursively
// normalized) `mc:Choice` content, discarding `mc:Fallback`; an
// `mc:AlternateContent` with no `mc:Choice` at all is malformed input — Word
// never emits this — and is left as-is rather than silently faked into
// content it never had.
function rewriteChild(child: ObjectBlobNode): readonly ObjectBlobNode[] {
  if (!isAlternateContentNode(child)) return [stripAlternateContentFallback(child)];
  const choice = choiceChildren(child);
  return choice ? choice.map(stripAlternateContentFallback) : [child];
}

/**
 * Recursively replaces every `mc:AlternateContent` descendant of `node` with
 * its `mc:Choice` child's children, spliced into the parent's children array
 * in its place — discarding `mc:Fallback` entirely (#517). Pure and total:
 * never mutates `node`, never throws. A tree with no `mc:AlternateContent`
 * anywhere is returned structurally unchanged; an `mc:AlternateContent` with
 * no `mc:Choice` child is left as-is rather than faked (malformed input,
 * never real Word output). `node` itself is never treated as an
 * `mc:AlternateContent` site — only its descendants are — matching every
 * known caller, which always passes a captured object's own host root
 * (`w:tbl` or `w:p`, `ObjectMetaSchema.blob`), never an `mc:AlternateContent`
 * node directly.
 */
export function stripAlternateContentFallback(node: ObjectBlobNode): ObjectBlobNode {
  const tag = tagOf(node);
  if (!tag) return node;
  const children = childrenOf(node);
  if (children.length === 0) return node;
  return { ...node, [tag]: children.flatMap(rewriteChild) };
}
