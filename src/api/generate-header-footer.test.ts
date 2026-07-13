import { afterEach, describe, it, expect, vi } from 'vitest';
import type { HeaderFooterComposition } from '../ast/index.js';
import type { HeaderFooterGenerationContext } from '../db/index.js';
import { buildHeaderFooterOptions } from './generate-header-footer.js';

afterEach(() => {
  vi.useRealTimers();
});

const COMPOSITION = { header: { left: { content: [] } } } as unknown as HeaderFooterComposition;

// I2: a null context is the one gate that keeps generateDocx's output
// byte-identical to the pre-#304 baseline — buildHeaderFooterOptions must
// surface that as undefined, not an empty options object.
describe('buildHeaderFooterOptions — I2 no-context gate', () => {
  it('generate-header-footer: null context (orphan/ambiguous/unconfigured spec) → undefined', () => {
    expect(buildHeaderFooterOptions(null)).toBeUndefined();
  });
});

// I4: a populated context maps composition straight through and stamps
// `current` with exactly the sourced fields plus today's date —
// packageName/revisionName/revisionLabel are never fabricated on this
// project-only-scope path (#304 decisions).
describe('buildHeaderFooterOptions — I4 field assembly', () => {
  it('generate-header-footer: populated context → composition pass-through + current stamped with sourced fields and date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T23:45:00Z'));

    const result = buildHeaderFooterOptions({
      composition: COMPOSITION,
      fieldValues: { projectName: 'Acme HQ', clientName: 'Acme Corp' },
    });

    expect(result).toEqual({
      composition: COMPOSITION,
      current: {
        date: '2026-07-12',
        projectName: 'Acme HQ',
        clientName: 'Acme Corp',
      },
    });
    // Never fabricated on this path — must stay absent, not merely undefined.
    expect(result?.current).not.toHaveProperty('packageName');
    expect(result?.current).not.toHaveProperty('revisionName');
    expect(result?.current).not.toHaveProperty('revisionLabel');
  });
});

// I5: never mutate the context object the caller passed in (code.md
// immutability rule) — freeze it so any attempted mutation throws in this
// ESM module's strict-mode execution, and confirm it reads back unchanged.
describe('buildHeaderFooterOptions — I5 no input mutation', () => {
  it('generate-header-footer: resolved context object is never mutated', () => {
    const fieldValues = Object.freeze({ projectName: 'Acme HQ' });
    const context: HeaderFooterGenerationContext = Object.freeze({
      composition: COMPOSITION,
      fieldValues,
    });

    expect(buildHeaderFooterOptions(context)).toBeDefined();

    expect(context.fieldValues).toEqual({ projectName: 'Acme HQ' });
    expect(context).toEqual({ composition: COMPOSITION, fieldValues: { projectName: 'Acme HQ' } });
  });
});

// I9: the stamped date is today's date, formatted YYYY-MM-DD — not a
// timestamp, not locale-dependent, and it tracks the clock rather than
// being hardcoded.
describe('buildHeaderFooterOptions — I9 date stamp format', () => {
  it('generate-header-footer: stamped date is today, formatted YYYY-MM-DD, single digits zero-padded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T00:00:00Z'));

    const result = buildHeaderFooterOptions({ composition: COMPOSITION, fieldValues: {} });

    expect(result?.current.date).toBe('2026-01-05');
    expect(result?.current.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
