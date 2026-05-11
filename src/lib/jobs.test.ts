import { describe, it, expect } from 'vitest';
import { createJob, updateJob, getJob } from './jobs.js';

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
