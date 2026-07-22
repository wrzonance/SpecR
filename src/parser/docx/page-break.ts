// ADR-075 manual page-break round-trip (#497): the pageBreakBefore resolution logic
// buildTree (inference.ts) uses to attach a manual page break onto whichever SpecNode
// actually ends up representing "the next thing after the paragraph the break was on" —
// extracted out of inference.ts to keep that file under the repo's max-lines budget.

import type { ClassifiedParagraph } from './types.js';
import type { SpecNode } from '../../ast/types.js';

// Mirrors sourceFactsMeta's shape convention: a manual page break is carried onto
// whichever SpecNode a classified paragraph becomes — structural (makeNode) or
// continuation/note (makeContinuationNode) alike. The caller resolves the effective
// flag (resolvePageBreakBefore below), so this is a pure boolean-to-meta lift, never
// a read of cp.paragraph directly.
export function pageBreakMeta(pageBreakBefore: boolean): { readonly pageBreakBefore?: boolean } {
  return pageBreakBefore ? { pageBreakBefore: true } : {};
}

// #497 review finding: a body object (table/text-box, ADR-072) attached right after
// the PREVIOUS classified paragraph sits between it and `classified[i]` in real
// document order — but document.ts's page-break lookback walks the raw <w:p>-only
// array (previousParagraphHasPageBreak), which is oblivious to an interleaved
// w:tbl. So `classified[i].paragraph.pageBreakBefore` can be a misattribution: the
// break really belongs to that object, not to this paragraph. Object nodes never
// carry meta.pageBreakBefore (ADR-075 decision 4 — an ImportedObjectBlock re-emits
// raw w:tbl XML, not a Paragraph, so there is no attachment point), so a
// misattributed flag is dropped here rather than misapplied to the wrong paragraph.
// KNOWN AMBIGUITY: see docs/adr/075-manual-page-break-round-trip.md.
function isPageBreakOwnedByPrecedingObject(
  i: number,
  objectsByPrecedingIndex: ReadonlyMap<number, readonly SpecNode[]>
): boolean {
  if (i === 0) return false;
  const objectsBefore = objectsByPrecedingIndex.get(i - 1);
  return objectsBefore !== undefined && objectsBefore.length > 0;
}

// #497 review finding: a page break preceding a paragraph that isStructuralContent
// filters out entirely (empty/blank spacer, or a suppressed rule-row delimiter,
// #292) must still surface on whatever paragraph is next actually emitted — it is
// never simply dropped just because the paragraph it landed on produced no node.
// Resolves the EFFECTIVE pageBreakBefore at index `i` from TWO independently-sourced
// signals (ADR-075 decision 8), which behave differently across an interposed object:
//
//   • FORWARDABLE — a break forwarded from an earlier filtered paragraph
//     (`pendingPageBreak`) OR read off the PRECEDING raw paragraph's trailing
//     `w:br` (`cp.paragraph.pageBreakBefore`). When a body object sits immediately
//     before index `i` (isPageBreakOwnedByPrecedingObject), that object physically
//     separates the source of this break from `cp` in real document order, so the
//     break is a misattribution (document.ts's w:p-only lookback is blind to the
//     interleaved w:tbl) and is dropped — objects can't carry it (decision 4).
//   • OWN — `cp`'s own `w:pPr/w:pageBreakBefore` property
//     (`cp.paragraph.ownPageBreakBefore`). Intrinsic to `cp`, never a
//     misattribution, so it survives EVEN across an interposed object.
//
// The result doubles as the NEXT pendingPageBreak when `cp` itself turns out to be
// filtered — "the break due here" is identical whether it lands on a node now or
// forwards on.
export function resolvePageBreakBefore(
  cp: ClassifiedParagraph,
  i: number,
  pendingPageBreak: boolean,
  objectsByPrecedingIndex: ReadonlyMap<number, readonly SpecNode[]>
): boolean {
  const own = cp.paragraph.ownPageBreakBefore === true;
  if (isPageBreakOwnedByPrecedingObject(i, objectsByPrecedingIndex)) return own;
  return own || pendingPageBreak || cp.paragraph.pageBreakBefore === true;
}
