import type { HeaderFooterGenerationContext } from '../db/index.js';
import type { HeaderFooterGenerationInput, HeaderFooterFieldValues } from '../generator/index.js';

/** Today's date, formatted `YYYY-MM-DD` — the one generation-time fact
 *  `buildHeaderFooterOptions` stamps that isn't sourced from the DB. Same
 *  UTC-based convention as `src/db/queries/revision-identity.ts`'s
 *  `todayIsoDate`, mirrored rather than shared (different module, no
 *  existing shared date-utility home). */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Map an already-resolved header/footer context (from
 * `resolveSpecGenerationContext`) to the generator-ready
 * `HeaderFooterGenerationInput`, or undefined when the context is null —
 * undefined is the one gate that keeps `generateDocx`'s output byte-identical
 * to the pre-#304 baseline. A pure mapper: it does no DB work, so the caller
 * owns the single ownership resolution that feeds both this and the
 * section-number-format fallback (issue #304). Stamps today's date as the one
 * generation-time fact not sourced from the DB;
 * `packageName`/`revisionName`/`revisionLabel` are never fabricated on this
 * project-only-scope path — they simply never appear in `current`.
 */
export function buildHeaderFooterOptions(
  context: HeaderFooterGenerationContext | null
): HeaderFooterGenerationInput | undefined {
  if (context === null) return undefined;

  const current: HeaderFooterFieldValues = {
    date: todayIsoDate(),
    ...context.fieldValues,
  };
  return { composition: context.composition, current };
}
