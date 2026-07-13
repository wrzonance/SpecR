import type { Pool } from 'pg';
import { resolveSpecHeaderFooterContext } from '../db/index.js';
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
 * Build the generator-ready `HeaderFooterGenerationInput` for a single
 * spec's generation, or undefined when nothing applies — undefined is the
 * one gate that keeps `generateDocx`'s output byte-identical to the
 * pre-#304 baseline. Stamps today's date as the one generation-time fact
 * not sourced from `resolveSpecHeaderFooterContext` (#304 decisions);
 * `packageName`/`revisionName`/`revisionLabel` are never fabricated on this
 * project-only-scope path — they simply never appear in `current`.
 */
export async function buildHeaderFooterOptions(
  specId: string,
  pool: Pool
): Promise<HeaderFooterGenerationInput | undefined> {
  const context = await resolveSpecHeaderFooterContext(specId, pool);
  if (context === null) return undefined;

  const current: HeaderFooterFieldValues = {
    date: todayIsoDate(),
    ...context.fieldValues,
  };
  return { composition: context.composition, current };
}
