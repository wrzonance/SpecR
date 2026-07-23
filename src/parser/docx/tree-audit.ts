import type { SpecNode, ParseWarning } from '../../ast/types.js';
import { auditPartNumbering } from '../part-prefix.js';

// Structural sanity audit for a built SpecTree's roots, split out of
// inference.ts to keep that file within the 400-line budget.

const TYPICAL_PART_COUNT = 3;
const PLAUSIBLE_MAX_PARTS = 5;

function partCountWarning(partCount: number): ParseWarning | null {
  if (partCount <= TYPICAL_PART_COUNT) return null;
  const suggestion =
    partCount > PLAUSIBLE_MAX_PARTS
      ? `${partCount} PART nodes detected — more than ${PLAUSIBLE_MAX_PARTS} usually means headings were over-matched`
      : `${partCount} PART nodes detected — MasterFormat allows this, but specs typically have ${TYPICAL_PART_COUNT}`;
  return { type: 'unusual-part-count', suggestion };
}

// Sanity post-pass: a healthy CSI parse has a small number of part-type roots
// (typically 3) and nothing else at root. Degraded parses previously rendered
// silently — 21 11 00agf.docx produced 34 roots with zero warnings.
export function auditTreeStructure(roots: readonly SpecNode[]): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  const visible = roots.filter((n) => n.meta.vanish !== true);
  const partCount = visible.filter((n) => n.type === 'part').length;
  // A captured body object (#300, ADR-072) at root — e.g. a table before the
  // document's first PART heading — is real, modeled content, never preamble
  // or unclassified junk; excluded here the same way 'part' itself is.
  const junkRoots = visible.filter((n) => n.type !== 'part' && n.type !== 'object');

  if (partCount === 0) {
    warnings.push({
      type: 'no-structure-found',
      suggestion:
        'no PART headings detected — document may not be a CSI spec, or its numbering convention is unrecognized',
    });
  }
  if (junkRoots.length > 0) {
    const first = junkRoots[0];
    warnings.push({
      type: 'root-continuation',
      ...(first && first.text ? { lineHint: first.text.slice(0, 60) } : {}),
      suggestion: `${junkRoots.length} node(s) at root level are not PART headings (preamble or unclassified content)`,
    });
  }
  const countWarning = partCountWarning(partCount);
  if (countWarning) warnings.push(countWarning);
  warnings.push(...auditPartNumbering(visible));
  return warnings;
}
