import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadRawSpec } from '../../test-utils/contract/validate-response.js';
import { PARAGRAPH_HISTORY_OPS } from './paragraph-history.js';

// PARAGRAPH_HISTORY_OPS, migration 055's OPS_SQL_LIST, and openapi.yaml's
// ParagraphHistoryEntry.op enum are three copies of one list, and both source
// comments say to "keep the two in lockstep by hand". Nothing checked the third.
//
// That drift is invisible to the rest of CI: `get /specs/{}/paragraphs/{}/history`
// is in contract.integration.test.ts's RESPONSE_ALLOWLIST, so no response-schema
// validation ever compares a real history payload against this enum. #545 added
// four ops (acknowledge/unacknowledge, close-comment/reopen-comment), every one
// of which writes a history row — and the enum went un-updated, so a perfectly
// valid response documented as impossible. Caught in review, not by a gate.
//
// A unit test, deliberately: it reads openapi.yaml and a frozen literal, needs
// no DB, and so runs in `pnpm test` on every push rather than behind the
// integration gate.
const OpEnumDoc = z.object({
  components: z.object({
    schemas: z.object({
      ParagraphHistoryEntry: z.object({
        properties: z.object({
          op: z.object({ enum: z.array(z.string()) }),
        }),
      }),
    }),
  }),
});

describe('openapi ParagraphHistoryEntry.op vs PARAGRAPH_HISTORY_OPS (#545)', () => {
  it('documents exactly the ops the DB accepts — no more, no fewer', async () => {
    const doc = OpEnumDoc.parse(await loadRawSpec());
    const documented = doc.components.schemas.ParagraphHistoryEntry.properties.op.enum;
    // Code-unit comparator, spelled as a statement: `sonarjs/no-alphabetical-sort`
    // rejects a bare `.sort()` and `sonarjs/no-nested-conditional` rejects the
    // one-line ternary form. Ordering only has to be stable for the comparison.
    const byCodeUnit = (a: string, b: string): number => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    };
    const sorted = (values: readonly string[]): string[] => [...values].sort(byCodeUnit);

    // Set equality in BOTH directions on purpose. A missing value documents a
    // real response as invalid (the #545 bug); an extra one documents an op the
    // DB's CHECK constraint would reject, so a client could branch on a case
    // that can never arrive.
    expect(sorted(documented)).toEqual(sorted(PARAGRAPH_HISTORY_OPS));
  });
});
