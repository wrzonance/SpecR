import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { SpecTree } from '../ast/index.js';

// Mirrors generate.test.ts's db/index.js mock shape: a stand-in
// ReadinessBlockedError class (so `instanceof` works the same way
// RevisionComparisonError's stub already does elsewhere) plus a mockable
// assertReadyForFinal.
vi.mock('../db/index.js', () => ({
  assertReadyForFinal: vi.fn(),
  ReadinessBlockedError: class ReadinessBlockedError extends Error {
    readonly findings: readonly unknown[];
    constructor(message: string, options: { findings: readonly unknown[] }) {
      super(message);
      this.findings = options.findings;
    }
  },
}));

function mockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

const tree: SpecTree = { id: 'spec', section: '09 91 26', title: 'Painting', parts: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enforceReadinessGate', () => {
  it('returns false and writes nothing when assertReadyForFinal no-ops (INV-1/INV-2/INV-3)', async () => {
    const { assertReadyForFinal } = await import('../db/index.js');
    vi.mocked(assertReadyForFinal).mockImplementationOnce(() => undefined);
    const { enforceReadinessGate } = await import('./readiness-guard.js');
    const res = mockRes();

    const blocked = enforceReadinessGate(res, [{ tree }], 'final', undefined);

    expect(blocked).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('writes a 422 pointing at the readiness-report endpoint and returns true on ReadinessBlockedError (INV-4)', async () => {
    const { assertReadyForFinal, ReadinessBlockedError } = await import('../db/index.js');
    const findings = [{ type: 'specifier_note_present' as const, nodeId: 'n1', text: 'note' }];
    vi.mocked(assertReadyForFinal).mockImplementationOnce(() => {
      throw new ReadinessBlockedError(
        'final issuance blocked: 1 readiness finding(s) outstanding',
        { findings }
      );
    });
    const { enforceReadinessGate } = await import('./readiness-guard.js');
    const res = mockRes();

    const blocked = enforceReadinessGate(res, [{ tree }], 'final', undefined);

    expect(blocked).toBe(true);
    expect(res.status).toHaveBeenCalledWith(422);
    // findings travel on the response (Codex review finding, #406) so a
    // caller gating a frozen revision snapshot — which has no
    // readiness-report endpoint of its own — still gets the exact
    // diagnostic, not just a count and a pointer to a live report that may
    // no longer match.
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error:
        'final issuance blocked: 1 readiness finding(s) outstanding — see GET .../readiness-report',
      findings,
    });
  });

  it('rethrows an error that is not ReadinessBlockedError rather than swallowing it (INV-13)', async () => {
    const { assertReadyForFinal } = await import('../db/index.js');
    const unrelated = new Error('unexpected failure');
    vi.mocked(assertReadyForFinal).mockImplementationOnce(() => {
      throw unrelated;
    });
    const { enforceReadinessGate } = await import('./readiness-guard.js');
    const res = mockRes();

    let caught: unknown;
    try {
      enforceReadinessGate(res, [{ tree }], 'final', undefined);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(unrelated);
    expect(res.status).not.toHaveBeenCalled();
  });
});
