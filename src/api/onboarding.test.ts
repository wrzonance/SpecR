import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { HeaderFooterComposition } from '../ast/index.js';

// Mock only process-edge collaborators; the REAL workerOutputSchema
// (src/lib/parse-worker.ts) stays in play so the boundary validation it provides
// is exercised, not stubbed.
vi.mock('../parser/index.js', () => ({
  assertDocxSafe: vi.fn().mockResolvedValue(undefined),
  assertSecSafe: vi.fn(),
  analyzeDocxStyles: vi.fn(),
  deriveTemplate: vi.fn(),
}));
vi.mock('../lib/parse-pool.js', () => ({
  parsePool: { run: vi.fn() },
}));
vi.mock('../lib/env.js', () => ({
  config: { OCR_MIN_CHARS_PER_PAGE: 16 },
}));
vi.mock('../lib/jobs.js', () => ({
  createOnboardingJob: vi.fn().mockReturnValue('onboard-job-id'),
  updateOnboardingJob: vi.fn(),
  getOnboardingJob: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  findLibraryById: vi.fn().mockResolvedValue({ id: 'lib-1', tier: 'company', name: 'L' }),
  persistParsedSpec: vi.fn().mockResolvedValue('spec-1'),
  createTemplateWithRules: vi.fn(),
  getTemplateByName: vi.fn(),
  bulkUpsertTemplateRules: vi.fn(),
  setSpecStyleSource: vi.fn(),
  reclassifySpec: vi.fn(),
  getSpecTree: vi.fn(),
  getSpecSource: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../lib/log-context.js', () => ({
  parseLog: vi.fn(() => ({ warn: vi.fn(), error: vi.fn() })),
  logParseWarnings: vi.fn(),
}));

function makeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function secReq(): Request {
  return {
    params: { id: '11111111-1111-4111-8111-111111111111' },
    file: { originalname: 'master.sec', mimetype: 'text/xml', buffer: Buffer.from('<?xml?>') },
  } as unknown as Request;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('importLibraryHandler — boundary + failure contract', () => {
  it('fails the job with stage:"failed" when worker output is malformed (boundary validation)', async () => {
    const { parsePool } = await import('../lib/parse-pool.js');
    const { updateOnboardingJob } = await import('../lib/jobs.js');
    // Malformed: no `tree` → workerOutputSchema.parse throws a ZodError that the
    // pipeline's catch turns into a clean, terminal failure (not an uncaught cast).
    vi.mocked(parsePool.run).mockResolvedValueOnce({ refs: [] });

    const { importLibraryHandler } = await import('./onboarding.js');
    const res = makeRes();
    await importLibraryHandler(secReq(), res);
    expect(res.status).toHaveBeenCalledWith(202);

    await vi.waitFor(() => {
      expect(updateOnboardingJob).toHaveBeenCalledWith(
        'onboard-job-id',
        expect.objectContaining({ status: 'failed', stage: 'failed' })
      );
    });
    // The failure carries a non-empty error message (cause-chained, not swallowed).
    const failCall = vi
      .mocked(updateOnboardingJob)
      .mock.calls.find((c) => c[1].status === 'failed');
    expect(typeof failCall?.[1].error).toBe('string');
    expect(failCall?.[1].error?.length ?? 0).toBeGreaterThan(0);
  });

  it('returns 404 without scheduling a job when the library is unknown', async () => {
    const { findLibraryById, persistParsedSpec } = await import('../db/index.js');
    vi.mocked(findLibraryById).mockResolvedValueOnce(null);
    const { createOnboardingJob } = await import('../lib/jobs.js');

    const { importLibraryHandler } = await import('./onboarding.js');
    const res = makeRes();
    await importLibraryHandler(secReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(createOnboardingJob).not.toHaveBeenCalled();
    expect(persistParsedSpec).not.toHaveBeenCalled();
  });
});

// #307 — OnboardingReport.headerFooter is a pure pass-through of the parsed
// tree's headerFooter (or null-collapsed when the source had none). Uses
// ext='.sec' so deriveStyleIfDocx short-circuits before analyzeDocxStyles/
// deriveTemplate, keeping the mock surface to parse-pool + db only.
describe('processOnboardingJob — report.headerFooter (#307)', () => {
  // Minimal SpecTree read back post-classification; parts:[] keeps
  // summarizeEditability/summarizeHierarchy trivial (both are pure over the
  // real tree shape, so they run unmocked here).
  function classifiedTree(): {
    tree: { id: string; section: string; title: string; parts: [] };
    references: [];
  } {
    return {
      tree: { id: 'spec-hf', section: '09 91 26', title: 'Painting', parts: [] },
      references: [],
    };
  }

  async function runOnboarding(
    headerFooter: HeaderFooterComposition | undefined
  ): Promise<unknown> {
    const { parsePool } = await import('../lib/parse-pool.js');
    const { getSpecTree, getSpecSource } = await import('../db/index.js');
    const { updateOnboardingJob } = await import('../lib/jobs.js');

    vi.mocked(parsePool.run).mockResolvedValueOnce({
      tree: {
        id: 'source-tree-hf',
        section: '09 91 26',
        title: 'Painting',
        parts: [],
        ...(headerFooter !== undefined ? { headerFooter } : {}),
      },
      refs: [],
    });
    vi.mocked(getSpecTree).mockResolvedValueOnce(classifiedTree());
    vi.mocked(getSpecSource).mockResolvedValueOnce(null);

    const { importLibraryHandler } = await import('./onboarding.js');
    const res = makeRes();
    await importLibraryHandler(secReq(), res);
    expect(res.status).toHaveBeenCalledWith(202);

    await vi.waitFor(() => {
      expect(updateOnboardingJob).toHaveBeenCalledWith(
        'onboard-job-id',
        expect.objectContaining({ status: 'complete' })
      );
    });
    const completeCall = vi
      .mocked(updateOnboardingJob)
      .mock.calls.find((c) => c[1].status === 'complete');
    return (completeCall?.[1] as { result?: { report?: { headerFooter?: unknown } } })?.result
      ?.report?.headerFooter;
  }

  it('passes tree.headerFooter through unchanged when the source has one', async () => {
    const headerFooter: HeaderFooterComposition = {
      header: { center: { content: [{ kind: 'sectionNumber' }] } },
    };
    const reportHeaderFooter = await runOnboarding(headerFooter);
    expect(reportHeaderFooter).toEqual(headerFooter);
  });

  it('null-collapses report.headerFooter when the source has none', async () => {
    const reportHeaderFooter = await runOnboarding(undefined);
    expect(reportHeaderFooter).toBeNull();
  });
});
