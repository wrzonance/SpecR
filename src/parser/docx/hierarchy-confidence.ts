// Read-time hierarchy-inference confidence scorer (ADR-055).
//
// Persisted facts in (signal_provenance + conflicts), derived score out — the
// formula improves without migration or reparse (render-derived house style).
// Evidence strings name SIGNALS, never source vendors (standing rule:
// signal-derived, never vendor-keyed).

import type {
  NodeType,
  SignalConflict,
  SignalNumber,
  SignalProvenance,
  SpecNodeInference,
} from '../../ast/index.js';
import { nodeTypeToNormalizedIlvl } from '../../ast/index.js';

// ── Formula v1 constants (ADR-055) — acknowledged heuristics, tunable here ────
// Base = the winning signal's reliability tier (ARCHITECTURE.md 5-signal table).
const SIGNAL_TIER: Record<SignalNumber, number> = {
  1: 0.95, // numbering.xml — what Word actually respects
  2: 0.85, // style chain
  3: 0.6, // document order
  4: 0.6, // text pattern
  5: 0.35, // indentation — fallback only
};

const SIGNAL_NAME: Record<SignalNumber, string> = {
  1: 'numbering.xml',
  2: 'style chain',
  3: 'document order',
  4: 'text pattern',
  5: 'indentation',
};

// Corroboration bonus per agreed signal = weight × that signal's own tier.
const CORROBORATION_WEIGHT = 0.15;
// Every recorded conflict is a nodeType mismatch (buildConflicts only keeps
// those), so the base penalty applies per conflict; ilvl distance scales it.
const CONFLICT_BASE_PENALTY = 0.1;
const CONFLICT_ILVL_STEP = 0.02;

function buildEvidence(
  provenance: SignalProvenance,
  conflicts: readonly SignalConflict[],
  nodeType: NodeType
): string[] {
  const winner = SIGNAL_NAME[provenance.signalUsed];
  const lines: string[] = [
    provenance.agreed.length === 0 && conflicts.length === 0
      ? `${winner} won alone`
      : `classified by ${winner}`,
  ];
  for (const signal of provenance.agreed) {
    lines.push(`corroborated by ${SIGNAL_NAME[signal]}`);
  }
  if (provenance.agreed.length === 0) {
    lines.push('no corroborating signal fired');
  }
  for (const c of conflicts) {
    lines.push(`${SIGNAL_NAME[c.signal]} disagreed: ${c.reportedNodeType} vs ${nodeType}`);
  }
  return lines;
}

/**
 * Derive a 0–1 hierarchy confidence from persisted provenance + conflicts.
 * Null provenance → null (an unscored row never yields a fake number).
 * Monotonic in corroboration, antitonic in disagreement, clamped to [0, 1].
 */
export function scoreHierarchyConfidence(
  provenance: SignalProvenance | null | undefined,
  conflicts: readonly SignalConflict[],
  nodeType: NodeType
): SpecNodeInference | null {
  if (provenance === null || provenance === undefined) return null;
  const winnerIlvl = nodeTypeToNormalizedIlvl(nodeType);
  const base = SIGNAL_TIER[provenance.signalUsed];
  const bonus = provenance.agreed.reduce(
    (sum, signal) => sum + CORROBORATION_WEIGHT * SIGNAL_TIER[signal],
    0
  );
  const penalty = conflicts.reduce(
    (sum, c) =>
      sum + CONFLICT_BASE_PENALTY + CONFLICT_ILVL_STEP * Math.abs(c.reportedIlvl - winnerIlvl),
    0
  );
  const confidence = Math.min(1, Math.max(0, base + bonus - penalty));
  return {
    confidence,
    signalUsed: provenance.signalUsed,
    agreed: provenance.agreed,
    evidence: buildEvidence(provenance, conflicts, nodeType),
  };
}
