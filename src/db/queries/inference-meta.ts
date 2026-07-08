import { SignalProvenanceSchema } from '../../ast/index.js';
import type { NodeType, SignalConflict, SpecNodeInference } from '../../ast/index.js';
import { scoreHierarchyConfidence } from '../../parser/index.js';

/**
 * Derive `meta.inference` from the raw signal_provenance JSONB column (ADR-055).
 * NULL column → undefined (field omitted — unscored honesty); a corrupt row
 * fails loud via Zod (surfaced as DatabaseError by the calling query's catch),
 * never a silent drop. Mirrors deriveEditability (specs.ts).
 */
export function deriveInference(
  raw: unknown,
  conflicts: readonly SignalConflict[],
  nodeType: NodeType
): SpecNodeInference | undefined {
  if (raw === null || raw === undefined) return undefined;
  const provenance = SignalProvenanceSchema.parse(raw);
  return scoreHierarchyConfidence(provenance, conflicts, nodeType) ?? undefined;
}
