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
