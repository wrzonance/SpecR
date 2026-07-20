import { describe, it, expect } from 'vitest';
import type { HeaderFooterComposition } from '../ast/index.js';
import {
  createJob,
  updateJob,
  getJob,
  createOnboardingJob,
  updateOnboardingJob,
  getOnboardingJob,
  type OnboardingReport,
} from './jobs.js';

function baseReport(headerFooter: OnboardingReport['headerFooter']): OnboardingReport {
  return {
    styleDerivation: null,
    styleSourceNeeded: true,
    headerFooter,
    editability: {
      counts: { locked: 0, editable: 0, choice: 0, note: 0 },
      lowConfidence: [],
    },
    highlightReview: { total: 0, findings: [] },
    hierarchy: {
      counts: { scored: 0, unscored: 0, belowThreshold: 0 },
      lowConfidence: [],
    },
    parseWarnings: [],
  };
}

describe('jobs', () => {
  it('createJob returns a UUID string', () => {
    const jobId = createJob();
    expect(jobId).toMatch(/^[\da-f-]{36}$/);
  });

  it('new job has status queued and pct 0', () => {
    const jobId = createJob();
    const job = getJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.progress.pct).toBe(0);
  });

  it('updateJob updates status', () => {
    const jobId = createJob();
    updateJob(jobId, { status: 'running' });
    expect(getJob(jobId)?.status).toBe('running');
  });

  it('updateJob updates stage and pct', () => {
    const jobId = createJob();
    updateJob(jobId, { stage: 'classifying', pct: 75 });
    expect(getJob(jobId)?.progress).toEqual({ stage: 'classifying', pct: 75 });
  });

  it('updateJob sets result', () => {
    const jobId = createJob();
    const result = { specId: 'abc', section: '01 10 00', title: 'T', nodeCount: 42 };
    updateJob(jobId, { status: 'complete', result });
    const job = getJob(jobId);
    expect(job?.result).toEqual(result);
    expect(job?.status).toBe('complete');
  });

  it('updateJob sets error', () => {
    const jobId = createJob();
    updateJob(jobId, { status: 'failed', error: 'boom' });
    expect(getJob(jobId)?.error).toBe('boom');
  });

  it('getJob returns undefined for unknown jobId', () => {
    expect(getJob('nonexistent-id')).toBeUndefined();
  });

  it('updateJob on unknown jobId is a no-op', () => {
    expect(() => updateJob('nonexistent', { status: 'running' })).not.toThrow();
  });
});

describe('onboarding job lifecycle (O-8)', () => {
  it('creates queued, advances stage, then completes with a result', () => {
    const jobId = createOnboardingJob();
    expect(getOnboardingJob(jobId)?.status).toBe('queued');

    updateOnboardingJob(jobId, { status: 'running', stage: 'parsing', pct: 20 });
    expect(getOnboardingJob(jobId)?.progress.stage).toBe('parsing');

    updateOnboardingJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: {
        specId: 's1',
        section: '09 91 26',
        title: 'Painting',
        libraryId: 'lib1',
        templateId: null,
        report: baseReport(null),
      },
    });
    const done = getOnboardingJob(jobId);
    expect(done?.status).toBe('complete');
    expect(done?.result?.report.styleSourceNeeded).toBe(true);
  });

  it('returns undefined for an unknown onboarding job id', () => {
    expect(getOnboardingJob('nope')).toBeUndefined();
  });

  it('onboarding store is separate from the parse-job store', () => {
    const parseId = createJob();
    expect(getOnboardingJob(parseId)).toBeUndefined();
  });
});

// These round-trip through the REAL onboarding job store (createOnboardingJob /
// updateOnboardingJob / getOnboardingJob), not just the local baseReport()
// fixture builder — updateOnboardingJob's `...update.result` spread is the
// production pass-through under test here (it must not clone/serialize the
// report), distinct from processOnboardingJob's `tree.headerFooter ?? null`
// null-collapse, which is covered against real production code in
// onboarding.test.ts's 'processOnboardingJob — report.headerFooter (#307)'.
describe('OnboardingReport.headerFooter (#307)', () => {
  function storeReport(
    headerFooter: OnboardingReport['headerFooter']
  ): OnboardingReport | undefined {
    const jobId = createOnboardingJob();
    updateOnboardingJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: {
        specId: 's2',
        section: '01 10 00',
        title: 'T',
        libraryId: 'lib1',
        templateId: null,
        report: baseReport(headerFooter),
      },
    });
    return getOnboardingJob(jobId)?.result?.report;
  }

  it('is present and null when the source tree had no header/footer composition', () => {
    const report = storeReport(null);
    expect(report).toHaveProperty('headerFooter');
    expect(report?.headerFooter).toBeNull();
  });

  it('round-trips a header/footer composition through the job store unchanged (pure pass-through)', () => {
    const composition: HeaderFooterComposition = {
      pageNumbering: { mode: 'continuous' },
    };
    const report = storeReport(composition);
    expect(report?.headerFooter).toBe(composition);
  });
});
