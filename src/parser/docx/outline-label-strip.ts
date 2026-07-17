// Post-tree-build label-stripping pass — mechanical extraction out of inference.ts
// (#300), zero behavior change: keeps inference.ts under the repo's 400-line file
// budget (code.md) after body-object attachment (buildTree's new params) pushed it
// over. buildTree calls stripOutlineLabels as its final step; nothing about the
// walk itself changed by moving it here.

import { getLabel, consumesNumber } from '../../ast/index.js';
import type { SpecNode } from '../../ast/types.js';
import { planLabelStrip, rebaseSourceFacts } from '../part-prefix.js';

// Strip a node's author-typed outline label IFF it equals the node's own render-derived
// CSI label — the article's "P.n" ("1.2 RELATED SECTIONS") or a pr tier's "A." / "1." /
// "a." ("A. General Cable"). This is the only reliable way to tell an outline LABEL (which
// IS the node's position) from a value/content that merely opens with it ("2.1 GHz", "A.
// Datum reference frame"): the strip fires only when the typed token equals the position's
// label, so a coincidental value is left verbatim. Source-fact offsets rebase onto the
// shorter text.
function stripNodeLabel(node: SpecNode, label: string): SpecNode {
  // The uppercase-title guard is an ARTICLE concern (tell a heading from a decimal value);
  // pr items are classified by their opening marker and often carry lowercase/numeric
  // content, so they strip on label-equality alone (Codex PR #432).
  const plan = planLabelStrip(node.text, label, node.type === 'article');
  if (!plan) return node;
  const facts = node.meta.sourceFacts;
  const meta = facts
    ? { ...node.meta, sourceFacts: rebaseSourceFacts(facts, plan.removed, plan.text.length) }
    : node.meta;
  return { ...node, text: plan.text, meta };
}

// The CSI label a structural node renders with, from its type and sibling ordinal. The
// article label needs the enclosing part's 1-based number ("1.2"); pr tiers ("A.", "1.",
// "a.") do not.
function labelFor(node: SpecNode, ordinal: number, partNumber: number): string {
  return node.type === 'article'
    ? getLabel('article', ordinal, partNumber)
    : getLabel(node.type, ordinal);
}

/**
 * Post-pass over the assembled tree: a node's position — and therefore its label — is
 * only known once the whole tree exists, so single-token article/pr labels ("1.1", "A.",
 * "1.") are stripped here, recursively. (Multi-dot pr numbers were already stripped
 * inline.) The walk mirrors the renderer's renderChildren: advance the ordinal only past
 * numbered siblings (consumesNumber) so each node's computed label equals what getLabel
 * prepends at render. Only Signal-4 (manual-outline) nodes strip; a numbered/style node's
 * text is content. `partNumber` is the enclosing part's 1-based number, threaded to the
 * article label and unused below it.
 */
export function stripOutlineLabels(
  nodes: readonly SpecNode[],
  s4NodeIds: ReadonlySet<string>,
  partNumber: number
): SpecNode[] {
  let ordinal = 0;
  return nodes.map((node) => {
    const labeled =
      consumesNumber(node) && s4NodeIds.has(node.id)
        ? stripNodeLabel(node, labelFor(node, ordinal, partNumber))
        : node;
    const childPartNumber = node.type === 'part' ? ordinal + 1 : partNumber;
    const withChildren: SpecNode = {
      ...labeled,
      children: stripOutlineLabels(labeled.children, s4NodeIds, childPartNumber),
    };
    if (consumesNumber(node)) ordinal += 1;
    return withChildren;
  });
}
