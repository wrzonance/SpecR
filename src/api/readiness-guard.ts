import type { Response } from 'express';
import type { IssuanceMode, SpecTree } from '../ast/index.js';
import { assertReadyForFinal, ReadinessBlockedError } from '../db/index.js';

// Shared by generateHandler / generateManualHandler / generateRevisionHandler
// (ADR-079, #406). `assertReadyForFinal` is imported through the db barrel
// per the sibling-barrel-only module-boundary rule — never straight from
// `db/queries/readiness-gate.js`.

interface ReadinessCheckedEntry {
  readonly tree: SpecTree;
}

/**
 * Runs the issuance-readiness gate and maps a block into the 422 response a
 * caller should see instead of discovering it from a 500. Returns `true`
 * once it has already written that response — the caller must `return`
 * immediately without generating a document. Returns `false` when
 * generation should proceed (draft, clean, or explicitly overridden).
 *
 * Any error other than `ReadinessBlockedError` is rethrown unchanged so each
 * handler's own catch-all still surfaces an unexpected failure as its
 * existing 500 — this helper never swallows an error it doesn't recognize.
 *
 * Synchronous — `assertReadyForFinal` never awaits anything, and this
 * repo's `@typescript-eslint/await-thenable` lint rule rejects `await` on a
 * non-`Promise` return, so every call site calls this directly (no `await`).
 */
export function enforceReadinessGate(
  res: Response,
  trees: readonly ReadinessCheckedEntry[],
  mode: IssuanceMode | undefined,
  overrideReadinessGate: boolean | undefined
): boolean {
  try {
    assertReadyForFinal(trees, mode, overrideReadinessGate);
    return false;
  } catch (err) {
    if (!(err instanceof ReadinessBlockedError)) throw err;
    res.status(422).json({
      success: false,
      error: `${err.message} — see GET .../readiness-report`,
    });
    return true;
  }
}
