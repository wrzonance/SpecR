import { z } from 'zod';

// ADR-065 — discipline mapping. A rule maps an inclusive CSI division range (2-digit,
// zero-padded) to a discipline identified by its catalog `key`. Divisions are compared
// as fixed-width strings, so lexicographic order equals numeric order.

/** A 2-digit CSI division (e.g. "26"). */
export const DivisionSchema = z.string().regex(/^\d{2}$/, 'division must be two digits');

/** One rule in a library's discipline rule set (write shape). */
export const DisciplineRuleInputSchema = z
  .object({
    discipline: z.string().check(z.minLength(1)).describe('Discipline key from GET /disciplines'),
    divisionStart: DivisionSchema,
    divisionEnd: DivisionSchema,
  })
  .refine((r) => r.divisionStart <= r.divisionEnd, {
    message: 'divisionStart must be <= divisionEnd',
    path: ['divisionEnd'],
  });

export type DisciplineRuleInput = z.infer<typeof DisciplineRuleInputSchema>;

/** Reject overlapping division ranges so section→discipline resolution stays deterministic. */
function hasNoOverlap(rules: readonly DisciplineRuleInput[]): boolean {
  const sorted = [...rules].sort((a, b) => a.divisionStart.localeCompare(b.divisionStart));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev !== undefined && curr !== undefined && curr.divisionStart <= prev.divisionEnd) {
      return false;
    }
  }
  return true;
}

/** PUT /libraries/{id}/disciplines body — a complete replacement rule set (>= 1 rule). */
export const SetDisciplinesBodySchema = z.object({
  rules: z
    .array(DisciplineRuleInputSchema)
    .check(z.minLength(1))
    .refine(hasNoOverlap, { message: 'division ranges must not overlap' }),
});

export type SetDisciplinesBody = z.infer<typeof SetDisciplinesBodySchema>;
