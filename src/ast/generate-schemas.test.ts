import { describe, it, expect } from 'vitest';
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
});
