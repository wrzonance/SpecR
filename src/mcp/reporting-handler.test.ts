// src/mcp/reporting-handler.test.ts
//
// Pins that handleCompareSpecs accepts the polymorphic CompareSource[] shape
// (#392, ADR-078) — a bare live-spec uuid or a { revisionId, specId } frozen
// source — and forwards it to buildComparisonReport unchanged (positional
// dispatch lives in report.ts, not the handler). ReportingError/SpecNotFoundError
// are imported for real (src/reporting/error.ts is pure, no db import) so the
// instanceof checks in the handler's catch block are exercised faithfully.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportingError, SpecNotFoundError } from '../reporting/error.js';
import { ANCHORS_META_KEY } from './anchors.js';
import type { ComparisonReport } from '../reporting/types.js';

vi.mock('../reporting/index.js', () => ({
  buildComparisonReport: vi.fn(),
  ReportingError,
  SpecNotFoundError,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const A = '11111111-1111-4111-8111-111111111111';
const REV1 = '44444444-4444-4444-8444-444444444444';

const EMPTY_REPORT: ComparisonReport = {
  columns: [],
  rows: [],
  summary: { rows: 0, aligned: 0, identical: 0, differing: 0, columns: [] },
  alignedBy: 'structure',
};

describe('handleCompareSpecs — accepts polymorphic CompareSource[] (#392)', () => {
  it('forwards a mix of live and frozen sources to buildComparisonReport unchanged', async () => {
    const reporting = await import('../reporting/index.js');
    vi.mocked(reporting.buildComparisonReport).mockResolvedValueOnce(EMPTY_REPORT);
    const { handleCompareSpecs } = await import('./reporting-handler.js');
    const sources = [A, { revisionId: REV1, specId: A }];

    const result = await handleCompareSpecs({ sources });

    expect(reporting.buildComparisonReport).toHaveBeenCalledWith(sources, {});
    expect('isError' in result).toBe(false);
  });

  it('surfaces a frozen-source SpecNotFoundError as isError, not a thrown exception', async () => {
    const reporting = await import('../reporting/index.js');
    vi.mocked(reporting.buildComparisonReport).mockRejectedValueOnce(
      new SpecNotFoundError(`frozen source not found: revisionId=${REV1}, specId=${A}`)
    );
    const { handleCompareSpecs } = await import('./reporting-handler.js');

    const result = await handleCompareSpecs({ sources: [A, { revisionId: REV1, specId: A }] });

    expect('isError' in result).toBe(true);
  });
});

// #392 review finding: two columns can legally share the same underlying
// specId — the same spec frozen at two different revisions, or a live spec
// compared against its own frozen snapshot (isFrozenSource/sourceSpecId,
// src/reporting/types.ts). Anchors must trace each present cell back to ITS
// OWN column (section + specId + paragraph UUID), never a section borrowed
// from whichever column happened to be indexed last under a shared specId key.
describe('handleCompareSpecs — anchors trace each cell to its own column, even when columns share a specId (#392)', () => {
  const TWO_COLUMNS_SAME_SPEC: ComparisonReport = {
    columns: [
      { specId: A, section: '09 91 26', title: 'Live' },
      {
        specId: A,
        section: '09 91 26 (as issued)',
        title: 'Frozen',
        revisionId: REV1,
        revisionLabel: 'Issued A',
      },
    ],
    rows: [
      {
        originId: 'origin-1',
        cells: [
          { present: true, specId: A, paragraphUuid: 'live-para', text: 'Live text' },
          { present: true, specId: A, paragraphUuid: 'frozen-para', text: 'Frozen text' },
        ],
      },
    ],
    summary: { rows: 1, aligned: 1, identical: 0, differing: 1, columns: [] },
    alignedBy: 'origin',
  };

  it('anchors each present cell against its own column, not a specId-collapsed lookup', async () => {
    const reporting = await import('../reporting/index.js');
    vi.mocked(reporting.buildComparisonReport).mockResolvedValueOnce(TWO_COLUMNS_SAME_SPEC);
    const { handleCompareSpecs } = await import('./reporting-handler.js');

    const result = await handleCompareSpecs({
      sources: [A, { revisionId: REV1, specId: A }],
    });

    if ('isError' in result) throw new Error('expected an ok result, got isError');
    expect(result._meta?.[ANCHORS_META_KEY]).toEqual([
      { section: '09 91 26', specId: A, paragraphId: 'live-para' },
      {
        section: '09 91 26 (as issued)',
        specId: A,
        paragraphId: 'frozen-para',
        revisionId: REV1,
      },
    ]);
  });

  // #392 review finding: a frozen cell's paragraphUuid names a paragraph AS
  // ISSUED, which may since have been edited/deleted live — omitting
  // revisionId left a UI client with no way to tell the anchor is historical
  // before trying (and possibly failing) to locate it in the live spec.
  it('a live column carries no revisionId on its anchor; a frozen column always does', async () => {
    const reporting = await import('../reporting/index.js');
    vi.mocked(reporting.buildComparisonReport).mockResolvedValueOnce(TWO_COLUMNS_SAME_SPEC);
    const { handleCompareSpecs } = await import('./reporting-handler.js');

    const result = await handleCompareSpecs({
      sources: [A, { revisionId: REV1, specId: A }],
    });

    if ('isError' in result) throw new Error('expected an ok result, got isError');
    const anchors = result._meta?.[ANCHORS_META_KEY] as { revisionId?: string }[] | undefined;
    expect(anchors?.[0]?.revisionId).toBeUndefined();
    expect(anchors?.[1]?.revisionId).toBe(REV1);
  });
});
