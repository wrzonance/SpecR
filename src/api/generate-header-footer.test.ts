import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { HeaderFooterComposition } from '../ast/index.js';

vi.mock('../db/index.js', () => ({
  resolveSpecHeaderFooterContext: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

const SPEC_ID = '0a4d4567-1b2c-4d3e-9f00-abcdefabcdef';
const FAKE_POOL = {} as Pool;
const COMPOSITION = { header: { left: { content: [] } } } as unknown as HeaderFooterComposition;

// I2: resolveSpecHeaderFooterContext returning null is the one gate that
// keeps generateDocx's output byte-identical to the pre-#304 baseline —
// buildHeaderFooterOptions must surface that as undefined, not an empty
// options object.
describe('buildHeaderFooterOptions — I2 no-context gate', () => {
  it('generate-header-footer: null context (orphan/ambiguous/unconfigured spec) → undefined', async () => {
    const { resolveSpecHeaderFooterContext } = await import('../db/index.js');
    vi.mocked(resolveSpecHeaderFooterContext).mockResolvedValueOnce(null);
    const { buildHeaderFooterOptions } = await import('./generate-header-footer.js');

    const result = await buildHeaderFooterOptions(SPEC_ID, FAKE_POOL);

    expect(result).toBeUndefined();
    expect(resolveSpecHeaderFooterContext).toHaveBeenCalledWith(SPEC_ID, FAKE_POOL);
  });
});

// I4: a populated context maps composition straight through and stamps
// `current` with exactly the sourced fields plus today's date —
// packageName/revisionName/revisionLabel are never fabricated on this
// project-only-scope path (#304 decisions).
describe('buildHeaderFooterOptions — I4 field assembly', () => {
  it('generate-header-footer: populated context → composition pass-through + current stamped with sourced fields and date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T23:45:00Z'));
    const { resolveSpecHeaderFooterContext } = await import('../db/index.js');
    vi.mocked(resolveSpecHeaderFooterContext).mockResolvedValueOnce({
      composition: COMPOSITION,
      fieldValues: { projectName: 'Acme HQ', clientName: 'Acme Corp' },
    });
    const { buildHeaderFooterOptions } = await import('./generate-header-footer.js');

    const result = await buildHeaderFooterOptions(SPEC_ID, FAKE_POOL);

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

// I5: never mutate the object resolveSpecHeaderFooterContext returned
// (code.md immutability rule) — freeze it so any attempted mutation throws
// in this ESM module's strict-mode execution, and confirm it reads back
// unchanged.
describe('buildHeaderFooterOptions — I5 no input mutation', () => {
  it('generate-header-footer: resolved context object is never mutated', async () => {
    const { resolveSpecHeaderFooterContext } = await import('../db/index.js');
    const fieldValues = Object.freeze({ projectName: 'Acme HQ' });
    const context = Object.freeze({ composition: COMPOSITION, fieldValues });
    vi.mocked(resolveSpecHeaderFooterContext).mockResolvedValueOnce(context);
    const { buildHeaderFooterOptions } = await import('./generate-header-footer.js');

    await expect(buildHeaderFooterOptions(SPEC_ID, FAKE_POOL)).resolves.toBeDefined();

    expect(context.fieldValues).toEqual({ projectName: 'Acme HQ' });
    expect(context).toEqual({ composition: COMPOSITION, fieldValues: { projectName: 'Acme HQ' } });
  });
});

// I9: the stamped date is today's date, formatted YYYY-MM-DD — not a
// timestamp, not locale-dependent, and it tracks the clock rather than
// being hardcoded.
describe('buildHeaderFooterOptions — I9 date stamp format', () => {
  it('generate-header-footer: stamped date is today, formatted YYYY-MM-DD, single digits zero-padded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T00:00:00Z'));
    const { resolveSpecHeaderFooterContext } = await import('../db/index.js');
    vi.mocked(resolveSpecHeaderFooterContext).mockResolvedValueOnce({
      composition: COMPOSITION,
      fieldValues: {},
    });
    const { buildHeaderFooterOptions } = await import('./generate-header-footer.js');

    const result = await buildHeaderFooterOptions(SPEC_ID, FAKE_POOL);

    expect(result?.current.date).toBe('2026-01-05');
    expect(result?.current.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
