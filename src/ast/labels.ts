import type { SpecNode, NodeType } from './types.js';

// Canonical CSI render-derived labels. These live in the AST module (not the
// generator) because BOTH sides need the same rule: the generator PREPENDS the
// label at render time, and the parser must know the label a node WOULD render so
// it can strip an author-typed duplicate ("1.2 RELATED SECTIONS" → "RELATED
// SECTIONS") WITHOUT touching a value that merely looks like one ("2.1 GHz" is not
// article 2.1's label unless it truly sits there). Reimplementing this in either
// place would let the two drift — keep it single-sourced here.

function alphaLabel(index: number, upper: boolean): string {
  let n = index + 1;
  let out = '';
  const base = upper ? 65 : 97;
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(base + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const PR_LABELS: Partial<Record<NodeType, (index: number) => string>> = {
  pr1: (index) => `${alphaLabel(index, true)}.`,
  pr2: (index) => `${index + 1}.`,
  pr3: (index) => `${alphaLabel(index, false)}.`,
  pr4: (index) => `${index + 1})`,
  pr5: (index) => `${alphaLabel(index, false)})`,
  pr6: (index) => `${index + 1})`,
  pr7: (index) => `${alphaLabel(index, false)})`,
};

/**
 * The CSI label a node renders with, from its type and its ordinal among numbered
 * siblings: part → "PART n -", article → "P.n" (P = 1-based part number), pr1 → "A.",
 * pr2 → "1.", … A note/continuation/vanish node has no label (it never consumes an
 * ordinal — see consumesNumber).
 */
export function getLabel(type: NodeType, index: number, partNumber = 1): string {
  if (type === 'part') return `PART ${index + 1} -`;
  if (type === 'article') return `${partNumber}.${index + 1}`;
  return PR_LABELS[type]?.(index) ?? '';
}

/**
 * Whether a node advances the CSI ordinal. Notes render as [NOTE] blockquotes,
 * continuations as plain text, and vanish nodes not at all — none carry a number,
 * so none may consume an ordinal (counting them shifted numbered siblings, #122).
 * Body objects ('object', 'objectText' — #300) are captured OOXML blobs rendered
 * out-of-band (a table/text-box block, or the plain text inside one); they never
 * sit among numbered CSI siblings, so they don't consume one either.
 * Both the renderer and the parser's label-strip walk the tree with this rule so a
 * node's computed ordinal is identical on both sides.
 */
export function consumesNumber(node: SpecNode): boolean {
  return (
    node.type !== 'note' &&
    node.type !== 'continuation' &&
    node.type !== 'object' &&
    node.type !== 'objectText' &&
    !node.meta.vanish
  );
}
