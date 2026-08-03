// Hidden-vs-visible txbxContent correlation (#515, ADR-086): body-objects.ts's
// anchor walk operates on the preserveOrder-mode blob tree (`ObjectBlobNode`),
// while text-box hidden detection (`isHiddenTextBox` et al.) operates on the
// grouped-mode `raw` tree the rest of document.ts already parsed. The two
// trees are independently parsed and share no node identity, so this module
// correlates them by DOCUMENT ORDER: `hiddenFlags[i]` describes the i'th
// `w:txbxContent` boundary found (depth-first, left to right) under a host
// paragraph's own blob children — the same order `runsOf(raw)` walks the
// grouped-mode side (ADR-072 design). Self-contained: no cross-import from
// body-objects.ts, mirroring the established per-module tagOf/childrenOf
// duplication already used by body-order.ts and body-objects.ts.

import type { ObjectBlobNode } from '../../ast/index.js';

function tagOf(node: ObjectBlobNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

// Hand-written type guard, not a bare `Array.isArray` check: TS narrows
// `Array.isArray` over a `readonly ObjectBlobNode[] | string` union to
// `any[]` (lib.es5.d.ts limitation), which would leak an unsafe `any[]`
// into every caller. Mirrors body-order.ts's / body-objects.ts's own
// isBlobNodeArray.
function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function childrenOf(node: ObjectBlobNode): readonly ObjectBlobNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const value = node[tag];
  return isBlobNodeArray(value) ? value : [];
}

// Depth-first collection of every `w:txbxContent`-tagged descendant of
// `node`'s OWN children (never `node` itself — the host paragraph is never
// mistaken for one of its own boundaries). Once a `w:txbxContent` node is
// found, its own children are NOT searched further: a text box's interior
// content is the opaque unit this module locates, not anything nested
// beneath it.
function collectTxbxContentNodes(node: ObjectBlobNode): ObjectBlobNode[] {
  const found: ObjectBlobNode[] = [];
  for (const child of childrenOf(node)) {
    if (tagOf(child) === 'w:txbxContent') {
      found.push(child);
      continue;
    }
    found.push(...collectTxbxContentNodes(child));
  }
  return found;
}

/**
 * Given a text box host paragraph's already-AC-normalized blob root and an
 * array of per-box hidden flags — one per textBox-classified DrawingRunEntry
 * found in the paragraph's `raw` (grouped-mode) representation, IN DOCUMENT
 * ORDER — returns the set of `w:txbxContent` ObjectBlobNode references
 * (identity-matched, found by walking hostNode's OWN children, never
 * hostNode itself) that the anchor walk must treat as opaque: pushed through
 * unchanged, no SDT anchor, no interiorTexts contribution.
 *
 * Fail-closed on correlation-count mismatch: if the number of w:txbxContent
 * boundaries found does not equal hiddenFlags.length (spike-confirmed
 * unreachable for every tested fixture shape — a defensive guard, not a live
 * path), every boundary found is treated as HIDDEN. Over-suppresses, never
 * leaks — the privacy invariant holds even under a correlation failure.
 */
export function resolveHiddenTxbxContentNodes(
  hostNode: ObjectBlobNode,
  hiddenFlags: readonly boolean[]
): ReadonlySet<ObjectBlobNode> {
  const boundaries = collectTxbxContentNodes(hostNode);
  if (boundaries.length !== hiddenFlags.length) {
    return new Set(boundaries);
  }
  const hidden = new Set<ObjectBlobNode>();
  boundaries.forEach((node, index) => {
    if (hiddenFlags[index] === true) hidden.add(node);
  });
  return hidden;
}
