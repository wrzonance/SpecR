import type { IssuanceMode, SpecTree } from '../../ast/index.js';
import { evaluateSpecReadiness, type ReadinessFinding } from '../../lib/readiness-review.js';
import { DatabaseError } from '../errors.js';

export interface ReadinessBlockedErrorOptions extends ErrorOptions {
  readonly findings: readonly ReadinessFinding[];
}

/**
 * Thrown by `assertReadyForFinal` when a `mode: 'final'` issuance is blocked
 * because readiness findings remain outstanding (ADR-079, decision 11). The
 * findings travel on the error itself — matching `StaleVersionError`'s
 * `currentVersion` precedent — so a caller can render the full picture
 * without a second lookup, and `instanceof DatabaseError` still holds for
 * every existing catch guard (e.g. `isUnprocessableRevisionInputError`).
 */
export class ReadinessBlockedError extends DatabaseError {
  readonly findings: readonly ReadinessFinding[];
  constructor(message: string, options: ReadinessBlockedErrorOptions) {
    super(message, options);
    this.findings = options.findings;
  }
}

interface ReadinessCheckedEntry {
  readonly tree: SpecTree;
}

/**
 * Pure, synchronous issuance-readiness gate (ADR-079). `mode !== 'final'` is
 * a complete no-op at zero evaluation cost (INV-1) — draft issuance never
 * pays for `evaluateSpecReadiness`. On `'final'`, a clean result across
 * every entry (INV-3) or an explicit `overrideReadinessGate: true` (INV-2 —
 * unaudited in this slice, ADR-079 decision 8) both no-op; otherwise it
 * throws `ReadinessBlockedError` carrying every outstanding finding across
 * all entries (INV-4). The highlight advisory is never consulted here — it
 * is report-only (ADR-079 decision 3), never a gate input.
 */
export function assertReadyForFinal(
  trees: readonly ReadinessCheckedEntry[],
  mode: IssuanceMode | undefined,
  overrideReadinessGate: boolean | undefined
): void {
  if (mode !== 'final') return;
  const findings = trees.flatMap((entry) => evaluateSpecReadiness(entry.tree).findings);
  if (findings.length === 0) return;
  if (overrideReadinessGate === true) return;
  throw new ReadinessBlockedError(
    `final issuance blocked: ${findings.length} readiness finding(s) outstanding`,
    { findings }
  );
}
