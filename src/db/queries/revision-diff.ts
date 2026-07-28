import { SpecTreeSchema } from '../../ast/index.js';
import type { SpecNode, SpecNodeMeta, SpecTree } from '../../ast/index.js';
import type { RevisionSpecEntry } from './revisions.js';

/** Strip purely-derived/provenance `meta` from a node tree so revision
 *  fingerprints compare authored content only. `articleRole` (ADR-033) is a
 *  deterministic function of the heading text — already in the fingerprint —
 *  and `originParagraphId` (#392, ADR-078) is captured lineage provenance, not
 *  authored content; both are absent from snapshots frozen before they
 *  existed. Including either would make a post-change revision read as
 *  "changed" against an otherwise identical pre-change base, falsely listing
 *  unchanged sections in the addendum. Add any future derived/provenance
 *  field here too. */
function stripDerivedMeta(nodes: readonly SpecNode[]): readonly SpecNode[] {
  return nodes.map((node) => {
    const meta = Object.fromEntries(
      Object.entries(node.meta).filter(
        ([key]) => key !== 'articleRole' && key !== 'originParagraphId'
      )
    ) as SpecNodeMeta;
    return { ...node, meta, children: stripDerivedMeta(node.children) };
  });
}

function treeFingerprint(tree: SpecTree): string {
  const parsed = SpecTreeSchema.parse(tree);
  return JSON.stringify({ ...parsed, parts: stripDerivedMeta(parsed.parts) });
}

export function changedRevisionSpecs(
  target: readonly RevisionSpecEntry[],
  base: readonly RevisionSpecEntry[]
): readonly RevisionSpecEntry[] {
  const baseBySpecId = new Map(base.map((entry) => [entry.specId, treeFingerprint(entry.tree)]));
  return target.filter((entry) => baseBySpecId.get(entry.specId) !== treeFingerprint(entry.tree));
}
