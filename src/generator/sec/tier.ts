import type { NodeType } from '../../ast/index.js';

// CSI paragraph tier as the SEC parser assigns it: an article is the depth-0
// SPT, and each deeper SPT (or a +1/+2 LST/ITM offset) increments the tier.
// `walkSpt` saturates at pr5, so tiers run 0 (article) … 5 (pr5).
const TIER: Readonly<Partial<Record<NodeType, number>>> = {
  article: 0,
  pr1: 1,
  pr2: 2,
  pr3: 3,
  pr4: 4,
  pr5: 5,
};

// Returns the SEC nesting tier for a structural node type, or null for the
// non-structural types (part, note, continuation, spec) the caller handles
// separately.
export function tierOf(type: NodeType): number | null {
  return TIER[type] ?? null;
}
