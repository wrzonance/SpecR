import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { GenerateBodySchema } from './generate-schemas.js';

// ADR-079 (#406): issuance-readiness gate. `mode`/`overrideReadinessGate` are
// additive optional fields shared with StructuredCreateRevisionBodySchema
// (via IssuanceModeSchema) — every existing `generate` caller that omits
// them keeps parsing exactly as before (INV-1 zero-cost default).

describe('GenerateBodySchema — mode / overrideReadinessGate (ADR-079)', () => {
  it('stays optional — a bare request body still validates', () => {
    const parsed = GenerateBodySchema.parse({});
    expect(parsed).not.toHaveProperty('mode');
    expect(parsed).not.toHaveProperty('overrideReadinessGate');
  });

  it('accepts an explicit draft mode', () => {
    expect(GenerateBodySchema.parse({ mode: 'draft' }).mode).toBe('draft');
  });

  it('accepts an explicit final mode plus overrideReadinessGate', () => {
    const parsed = GenerateBodySchema.parse({ mode: 'final', overrideReadinessGate: true });
    expect(parsed.mode).toBe('final');
    expect(parsed.overrideReadinessGate).toBe(true);
  });

  it('rejects a mode value outside the draft/final enum', () => {
    expect(GenerateBodySchema.safeParse({ mode: 'published' }).success).toBe(false);
  });

  it('rejects a non-boolean overrideReadinessGate', () => {
    expect(
      GenerateBodySchema.safeParse({ mode: 'final', overrideReadinessGate: 'yes' }).success
    ).toBe(false);
  });

  // Review finding (#406): a misspelled/unrecognized field must not silently
  // strip past the ADR-079 readiness gate — `.strict()` surfaces it as a 400
  // instead of the request quietly parsing as if the field were never sent.
  it('rejects an unrecognized top-level field instead of silently stripping it', () => {
    expect(GenerateBodySchema.safeParse({ mdoe: 'final' }).success).toBe(false);
  });

  it('still parses baseRevisionId through RevisionGenerateBodySchema’s .extend()', () => {
    const RevisionGenerateBodySchema = GenerateBodySchema.extend({
      baseRevisionId: z.uuid().optional(),
    });
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const parsed = RevisionGenerateBodySchema.safeParse({ mode: 'final', baseRevisionId: uuid });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.baseRevisionId).toBe(uuid);
  });

  it('still rejects an unrecognized field on the extended revision schema', () => {
    const RevisionGenerateBodySchema = GenerateBodySchema.extend({
      baseRevisionId: z.uuid().optional(),
    });
    expect(RevisionGenerateBodySchema.safeParse({ mdoe: 'final' }).success).toBe(false);
  });
});
