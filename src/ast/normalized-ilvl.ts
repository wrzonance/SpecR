import { AstError } from './error.js';
import type { NodeType } from './types.js';

// Canonical normalized ilvl: part=0, article=1, pr1=2, ..., pr7=8.
// Single source of truth shared by the inference engine (signal resolution),
// the hierarchy-confidence scorer (conflict ilvl distance), and the report
// summarizer (lowConfidence entries). The by-ilvl list is authoritative; the
// lookup map is derived from it so the two can never drift.
export const NODE_TYPES_BY_NORMALIZED_ILVL: readonly NodeType[] = [
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
];

export const NODE_TYPE_TO_NORMALIZED_ILVL: Partial<Record<NodeType, number>> = Object.fromEntries(
  NODE_TYPES_BY_NORMALIZED_ILVL.map((nodeType, ilvl): [NodeType, number] => [nodeType, ilvl])
);

export function nodeTypeToNormalizedIlvl(nodeType: NodeType): number {
  const ilvl = NODE_TYPE_TO_NORMALIZED_ILVL[nodeType];
  if (ilvl === undefined) {
    // Fail loud: a silent 0 would alias non-structural/future types onto 'part'
    // and corrupt conflict ilvl-distance penalties instead of surfacing the
    // missing mapping (callers filter to structural types before calling).
    throw new AstError(`nodeTypeToNormalizedIlvl: no normalized ilvl for node type "${nodeType}"`);
  }
  return ilvl;
}
