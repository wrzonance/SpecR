import { NODE_TYPES_BY_NORMALIZED_ILVL } from '../../ast/index.js';
import { leadingMarkerOrdinal } from './heuristics.js';
import type { ClassifiedParagraph } from './types.js';

// Post-classification sequence pass (ADR-059). A no-typed-label lead-in — a
// Word/style/indent-numbered paragraph that INTRODUCES a manual sub-list — and
// the sub-list often resolve to the SAME tier, so buildTree lands the sub-list as
// SIBLINGS of its lead-in and the renderer double-labels ("2. 1. Authority").
//
// When a lead-in collides at tier T with an immediately-following Signal-4 restart
// run (first typed marker = ordinal 1), PROMOTE the lead-in to T−1. The run stays
// at T, so buildTree nests it as children and the existing stripOutlineLabels
// post-pass strips the now-matching typed markers. We promote the lead-in rather
// than demote the sub-list because the lead-in has no typed label of its own —
// promoting it stays clean, whereas demoting the run would leave its "1." markers
// unstripped under a different scheme. This is the text/structure sibling of the
// style-based LEAD_IN_STYLE mechanism in inference.ts.

// The real candidacy invariant: the paragraph carries NO typed outline label of
// its own. Signal 4 is the ONLY classifier that reads a marker ("1.", "A.") from
// the text; every other signal (numbering.xml, style, document order, indentation)
// derives the tier without a marker, so the text is pure content. Promoting a
// labelled node would double-label it (its own "1." plus the promoted tier's
// computed label); promoting an unlabelled lead-in stays clean. Keyed on this
// property, NOT a signal-number list — the lead-ins that actually hit this defect
// resolve via Signal 5 (indentation), not the numbering signals (ADR-059).
function hasNoTypedLabel(cp: ClassifiedParagraph): boolean {
  return cp.signalUsed !== 4;
}

// A promotable lead-in has no typed label of its own, is structural (a continuation
// has no independent tier), and sits at pr1+ (ilvl ≥ 2) — an article is never
// promoted to a PART.
function isLeadInCandidate(cp: ClassifiedParagraph): boolean {
  return cp.nodeType !== 'continuation' && hasNoTypedLabel(cp) && cp.resolvedIlvl >= 2;
}

// Length of the consecutive Signal-4 run at exactly `tier`, starting at `from`.
function restartRunLength(
  classified: readonly ClassifiedParagraph[],
  from: number,
  tier: number
): number {
  let count = 0;
  for (let k = from; k < classified.length; k += 1) {
    const cp = classified[k];
    if (!cp || cp.signalUsed !== 4 || cp.resolvedIlvl !== tier) break;
    count += 1;
  }
  return count;
}

// Tier of the lead-in's structural parent: the nearest preceding non-continuation
// item strictly above `tier`. −1 when the lead-in has no structural parent (root).
// Computed on the ORIGINAL array so a just-promoted earlier lead-in cannot be
// mistaken for a sibling's parent.
function structuralParentTier(
  classified: readonly ClassifiedParagraph[],
  index: number,
  tier: number
): number {
  for (let k = index - 1; k >= 0; k -= 1) {
    const cp = classified[k];
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

function shouldPromote(classified: readonly ClassifiedParagraph[], index: number): boolean {
  const x = classified[index];
  if (!x || !isLeadInCandidate(x)) return false;
  const tier = x.resolvedIlvl;
  const first = classified[index + 1];
  // The run must start immediately at the same tier — a colliding sub-list, not a
  // continuation or a deeper/shallower item.
  if (!first || first.signalUsed !== 4 || first.resolvedIlvl !== tier) return false;
  if (leadingMarkerOrdinal(first.paragraph.text) !== 1) return false;
  if (restartRunLength(classified, index + 1, tier) < minRunFor(x.paragraph.text)) return false;
  // Promotion room: T−1 must remain strictly deeper than the structural parent.
  return structuralParentTier(classified, index, tier) < tier - 1;
}

// Promote by one tier, recording the pre-promotion tier as a conflict so the
// inferred correction is persisted (never dropped) and lowers hierarchy
// confidence. Provenance (signalUsed/agreed) is preserved as an honest record of
// how the tier was originally read.
function promote(x: ClassifiedParagraph): ClassifiedParagraph {
  const promotedIlvl = x.resolvedIlvl - 1;
  const promotedType = NODE_TYPES_BY_NORMALIZED_ILVL[promotedIlvl];
  if (promotedType === undefined) return x; // unreachable: candidate tier ≥ 2
  return {
    ...x,
    resolvedIlvl: promotedIlvl,
    nodeType: promotedType,
    conflicts: [
      ...x.conflicts,
      { signal: x.signalUsed, reportedIlvl: x.resolvedIlvl, reportedNodeType: x.nodeType },
    ],
  };
}

/**
 * Promote each no-typed-label lead-in that collides at its resolved tier with an
 * immediately-following Signal-4 restart sub-list, so the sub-list nests as
 * children and its typed labels strip clean. Pure: returns a new array, reuses
 * unchanged element references, and never mutates the input.
 */
export function nestLeadInSublists(
  classified: readonly ClassifiedParagraph[]
): ClassifiedParagraph[] {
  return classified.map((cp, index) => (shouldPromote(classified, index) ? promote(cp) : cp));
}
