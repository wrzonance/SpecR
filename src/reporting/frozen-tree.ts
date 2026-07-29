import type { SpecNode, SpecTree } from '../ast/index.js';
import type { ComparisonParagraph } from './types.js';

/**
 * Flattens a frozen `SpecTree` (a `package_revision_specs.tree` JSONB snapshot,
 * ADR-078) into the same flat row shape the live loader emits
 * (`getComparisonParagraphs`, src/db/queries/reporting.ts), so `alignTrees` can
 * treat a frozen revision column exactly like a live one. Pure — no pg import,
 * no I/O — deliberately named `frozen-tree.ts` rather than `frozen-loader.ts`
 * to stay obviously outside `src/reporting/`'s never-imports-pg boundary.
 *
 * `position` is a per-parent DFS visitation index recomputed from the stored
 * children-array order (a frozen tree carries no absolute DB `position`
 * column). This only needs to preserve sibling ORDER, not reproduce the live
 * loader's raw integers — `computeStructuralKeys` (structure.ts) derives its
 * ordinal from same-nodeType sibling counts, which is invariant to renumbering
 * as long as relative order is kept.
 */
export function flattenSpecTree(tree: SpecTree, specId: string): readonly ComparisonParagraph[] {
  return flattenSiblings(tree.parts, specId, null);
}

/** Owner-removed subtrees (vanish=true, non-`note`) are excluded entirely —
 *  parity with the live loader's recursive CTE, which drops the same set ∪ all
 *  descendants regardless of the descendants' own vanish/type (merge/render
 *  parity, ADR-047). */
function isOwnerRemoved(node: SpecNode): boolean {
  return node.meta.vanish === true && node.type !== 'note';
}

/**
 * Flatten one sibling array under `parentId`, DFS pre-order. Owner-removed
 * children (and their descendants) are dropped before position assignment, so
 * `position` only counts rows that actually appear in the output — matching
 * the live loader, whose removed rows never occupy a slot in its result set
 * either (they are deleted from the row set before ORDER BY runs).
 *
 * KNOWN AMBIGUITY: a node with empty `text` is retained here unfiltered, same
 * as any other row — the flattener trusts its input already satisfies
 * `SpecNodeSchema` (`text` has `minLength(1)`, ast/spec-tree-schemas.ts),
 * which `validateTree` enforces at freeze time (revision-snapshot.ts) before a
 * tree can ever reach this function. The live loader instead retains
 * empty-text paragraphs BY DESIGN (ADR-047 — dropping them would be an
 * untraceable hole in the matrix); this flattener has no equivalent design
 * choice to make because the schema boundary already prevents the case in
 * production. Pinned in frozen-tree.test.ts rather than silently assumed.
 */
function flattenSiblings(
  siblings: readonly SpecNode[],
  specId: string,
  parentId: string | null
): readonly ComparisonParagraph[] {
  return siblings
    .filter((node) => !isOwnerRemoved(node))
    .flatMap((node, position) => [
      toComparisonParagraph(node, specId, parentId, position),
      ...flattenSiblings(node.children, specId, node.id),
    ]);
}

function toComparisonParagraph(
  node: SpecNode,
  specId: string,
  parentId: string | null,
  position: number
): ComparisonParagraph {
  return {
    specId,
    id: node.id,
    originParagraphId: node.meta.originParagraphId ?? null,
    text: node.text,
    position,
    parentId,
    nodeType: node.type,
  };
}
