import { NODE_TYPES_BY_NORMALIZED_ILVL } from '../../ast/index.js';
import { leadingMarkerOrdinal } from './heuristics.js';
import type { ClassifiedParagraph, SignalConflict } from './types.js';

// Post-classification sequence pass (ADR-059). A no-typed-label lead-in — a
// numbering/style/indent-classified paragraph that INTRODUCES a manual sub-list —
// and the sub-list often resolve to the SAME tier, so buildTree lands the sub-list
// as SIBLINGS of its lead-in and the renderer double-labels ("2. 1. Authority").
//
// When a lead-in collides at tier T with an immediately-following Signal-4 restart
// run (first typed marker = ordinal 1), PROMOTE the lead-in to T−1. The run stays
// at T, so buildTree nests it as children and the existing stripOutlineLabels
// post-pass strips the now-matching typed markers. We promote the lead-in rather
// than demote the sub-list because the lead-in has no typed label of its own —
// promoting it stays clean, whereas demoting the run would leave its "1." markers
// unstripped under a different scheme. This is the text/structure sibling of the
// style-based LEAD_IN_STYLE mechanism in inference.ts.
//
// Promoting a lead-in must not STRAND a same-tier peer lead-in under it: when X is
// promoted, a following peer lead-in Y at the same tier sharing X's parent
// ("References Standards:" after "Definitions:") is promoted too — even without a
// sub-list of its own — so the author's peer group (A./B./C.) stays a peer group
// instead of Y being vacuumed under the last promoted sibling.

// The candidacy invariant: the paragraph carries NO typed outline label of its own.
// Signal 4 is the ONLY classifier that reads a marker ("1.", "A.", "1.2.3") from
// the text; every other signal (numbering.xml, style, document order, indentation)
// derives the tier without a marker, so the text is pure content. A node can WIN via
// Signal 1/2 (Word/style numbering) yet still carry a literal "1." that Signal 4 saw
// and recorded in agreed/conflicts — promoting it would double-label ("A. 1. Group:")
// because buildTree's strip only fires on a Signal-4 winner. So candidacy requires
// that Signal 4 did not fire AT ALL, not merely that it wasn't the winner.
function signal4Fired(cp: ClassifiedParagraph): boolean {
  return (
    cp.signalUsed === 4 ||
    cp.agreed.includes(4) ||
    cp.conflicts.some((conflict) => conflict.signal === 4)
  );
}

// A promotable lead-in has no typed label of its own, is structural (a continuation
// has no independent tier), and sits at pr1+ (ilvl ≥ 2) — an article is never
// promoted to a PART.
function isLeadInCandidate(cp: ClassifiedParagraph): boolean {
  return cp.nodeType !== 'continuation' && !signal4Fired(cp) && cp.resolvedIlvl >= 2;
}

function endsWithColon(cp: ClassifiedParagraph): boolean {
  return cp.paragraph.text.trimEnd().endsWith(':');
}

// Length of the consecutive Signal-4 run at exactly `tier`, starting at `from`.
function restartRunLength(
  content: readonly ClassifiedParagraph[],
  from: number,
  tier: number
): number {
  let count = 0;
  for (let k = from; k < content.length; k += 1) {
    const cp = content[k];
    if (!cp || cp.signalUsed !== 4 || cp.resolvedIlvl !== tier) break;
    count += 1;
  }
  return count;
}

// Tier of the lead-in's structural parent: the nearest preceding non-continuation
// item strictly above `tier`. −1 when the lead-in has no structural parent (root).
function structuralParentTier(
  content: readonly ClassifiedParagraph[],
  index: number,
  tier: number
): number {
  for (let k = index - 1; k >= 0; k -= 1) {
    const cp = content[k];
    if (cp && cp.nodeType !== 'continuation' && cp.resolvedIlvl < tier) {
      return cp.resolvedIlvl;
    }
  }
  return -1;
}

// Colon acts as a modulator, not a gate: a lead-in ending ":" fires on a single
// restart item; a colon-less lead-in is held to ≥2 (slightly stronger evidence).
function minRunFor(text: string): number {
  return text.trimEnd().endsWith(':') ? 1 : 2;
}

// A PRIMARY promotion: X owns an immediately-following Signal-4 restart run at its
// own tier. `content` is the non-empty view (buildTree drops blanks, so a blank
// between the lead-in and its list must not defeat the adjacency check).
function isPrimaryPromotion(content: readonly ClassifiedParagraph[], index: number): boolean {
  const x = content[index];
  if (!x || !isLeadInCandidate(x)) return false;
  const tier = x.resolvedIlvl;
  const first = content[index + 1];
  // The run must start immediately at the same tier — a colliding sub-list, not a
  // continuation or a deeper/shallower item.
  if (!first || first.signalUsed !== 4 || first.resolvedIlvl !== tier) return false;
  if (leadingMarkerOrdinal(first.paragraph.text) !== 1) return false;
  if (restartRunLength(content, index + 1, tier) < minRunFor(x.paragraph.text)) return false;
  // Promotion room: T−1 must remain strictly deeper than the structural parent.
  return structuralParentTier(content, index, tier) < tier - 1;
}

// A STRANDED peer: Y is a lead-in candidate ending ":" and some primary promotion at
// Y's tier precedes it within the same parent scope (no shallower node between them).
// Y shares that parent, so promoting Y one tier keeps it a sibling of the primary
// rather than a child of it. Room is inherited from the primary (same parent).
function isStrandedPeer(
  content: readonly ClassifiedParagraph[],
  index: number,
  primary: readonly boolean[]
): boolean {
  const y = content[index];
  if (!y || !isLeadInCandidate(y) || !endsWithColon(y)) return false;
  const tier = y.resolvedIlvl;
  for (let k = index - 1; k >= 0; k -= 1) {
    const node = content[k];
    if (!node) continue;
    if (node.resolvedIlvl < tier) return false; // left the parent scope
    if (node.resolvedIlvl === tier && primary[k] === true) return true;
  }
  return false;
}

// Promote by one tier, RECOMPUTING provenance so it reflects an inferred structural
// correction, not a signal consensus. Every signal that fired (the winner AND every
// prior `agreed`) reported the OLD tier T; after promoting to T−1 none corroborates
// the node's final tier. So `agreed` becomes [] and all old-tier votes are folded
// into `conflicts` at the old tier — losing votes persisted (never dropped), and
// scoreHierarchyConfidence then sees no corroboration + N conflicts → an honestly
// LOW confidence for the promotion, instead of a bonus from now-stale agreement.
// signalUsed is kept (there is no signal id for the pass); the scorer reads it only
// as a base reliability tier, not as agreement with the new tier.
function promote(x: ClassifiedParagraph): ClassifiedParagraph {
  const promotedIlvl = x.resolvedIlvl - 1;
  const promotedType = NODE_TYPES_BY_NORMALIZED_ILVL[promotedIlvl];
  if (promotedType === undefined) return x; // unreachable: candidate tier ≥ 2
  const oldTierVotes: SignalConflict[] = [x.signalUsed, ...x.agreed].map((signal) => ({
    signal,
    reportedIlvl: x.resolvedIlvl,
    reportedNodeType: x.nodeType,
  }));
  return {
    ...x,
    resolvedIlvl: promotedIlvl,
    nodeType: promotedType,
    agreed: [],
    conflicts: [...x.conflicts, ...oldTierVotes],
  };
}

/**
 * Promote each no-typed-label lead-in that collides at its resolved tier with an
 * immediately-following Signal-4 restart sub-list (so the sub-list nests and its
 * typed labels strip clean), plus any same-tier peer lead-in that would otherwise
 * be stranded under a promoted sibling. Pure: returns a new array, reuses unchanged
 * element references, and never mutates the input. Decisions are computed over the
 * non-empty content view (matching buildTree, which drops blank paragraphs).
 */
export function nestLeadInSublists(
  classified: readonly ClassifiedParagraph[]
): ClassifiedParagraph[] {
  // Must match buildTree's content view exactly (inference.ts): drop blanks AND
  // suppressed rule-row delimiters (#292), or a rule row between a lead-in and its
  // Signal-4 restart run defeats the same-tier adjacency check below.
  const content = classified.filter(
    (cp) => cp.paragraph.text.trim().length > 0 && cp.suppressed !== true
  );
  const primary = content.map((_cp, index) => isPrimaryPromotion(content, index));
  const toPromote = new Set<ClassifiedParagraph>();
  content.forEach((cp, index) => {
    if (primary[index] === true || isStrandedPeer(content, index, primary)) toPromote.add(cp);
  });
  return classified.map((cp) => (toPromote.has(cp) ? promote(cp) : cp));
}
