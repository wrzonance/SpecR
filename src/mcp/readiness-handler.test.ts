// src/mcp/readiness-handler.test.ts
//
// ADR-079 (#406) — the readiness_report MCP tool. Mirrors
// open-comments-handler.test.ts's isolation pattern (mock '../db/index.js'
// so this stays a pure no-DB unit test) and pins two invariants at THIS new
// JSON-over-stdio boundary, re-verifying guarantees already proven at the
// REST boundary (readiness.integration.test.ts) now hold once more data
// crosses a second serialization layer:
//   - INV-13: SpecNotFoundError/PackageNotFoundError surface as their own
//     distinct isError message, never the generic "Internal error" catch-all
//     an unrecognized failure gets.
//   - INV-15: package-scope aggregation still attributes every finding to
//     the correct member spec after a JSON.stringify/JSON.parse round trip.
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeSpecNotFound extends Error {}
class FakePackageNotFound extends Error {}

vi.mock('../db/index.js', () => ({
  getReadinessReport: vi.fn(),
  SpecNotFoundError: FakeSpecNotFound,
  PackageNotFoundError: FakePackageNotFound,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC = '10000000-0000-4000-8000-000000000001';
const PACKAGE = '20000000-0000-4000-8000-000000000002';

describe('resolveReadinessScope — exactly one of specId/packageId (#406)', () => {
  it('errors and skips the DB when neither specId nor packageId is given', async () => {
    const db = await import('../db/index.js');
    const { handleReadinessReport } = await import('./readiness-handler.js');

    const result = await handleReadinessReport({});

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(db.getReadinessReport)).not.toHaveBeenCalled();
  });

  it('errors and skips the DB when BOTH specId and packageId are given', async () => {
    const db = await import('../db/index.js');
    const { handleReadinessReport } = await import('./readiness-handler.js');

    const result = await handleReadinessReport({ specId: SPEC, packageId: PACKAGE });

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(db.getReadinessReport)).not.toHaveBeenCalled();
  });

  it('calls the report with a spec scope and returns JSON content', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getReadinessReport).mockResolvedValue({
      scope: { kind: 'spec', specId: SPEC },
      findings: [],
      highlightAdvisory: [],
      summary: {
        unresolvedChoiceToken: 0,
        specifierNotePresent: 0,
        openComment: 0,
        bodyObjectPresent: 0,
        total: 0,
      },
      readyForFinal: true,
    });
    const { handleReadinessReport } = await import('./readiness-handler.js');

    const result = await handleReadinessReport({ specId: SPEC });

    expect(vi.mocked(db.getReadinessReport)).toHaveBeenCalledWith({ kind: 'spec', specId: SPEC });
    expect(result).not.toHaveProperty('isError');
    const parsed = JSON.parse(result.content[0]?.text ?? '') as { readyForFinal: boolean };
    expect(parsed.readyForFinal).toBe(true);
  });
});

describe('handleReadinessReport — error mapping never swallows into a generic error (INV-13)', () => {
  it('returns isError carrying the SpecNotFoundError message verbatim', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getReadinessReport).mockRejectedValue(new FakeSpecNotFound('spec missing'));
    const { handleReadinessReport } = await import('./readiness-handler.js');

    const result = await handleReadinessReport({ specId: SPEC });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toBe('spec missing');
  });

  it('returns isError carrying the PackageNotFoundError message verbatim', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getReadinessReport).mockRejectedValue(new FakePackageNotFound('package missing'));
    const { handleReadinessReport } = await import('./readiness-handler.js');

    const result = await handleReadinessReport({ packageId: PACKAGE });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toBe('package missing');
  });

  it('falls back to a generic internal error for an unrecognized failure, never leaking internals', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getReadinessReport).mockRejectedValue(new Error('pg connection reset'));
    const { handleReadinessReport } = await import('./readiness-handler.js');

    const result = await handleReadinessReport({ specId: SPEC });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).not.toContain('pg connection reset');
  });

  // Review finding (#406): unlike readiness.ts's REST mapError (logger.error
  // before the generic 500), this MCP catch-all dropped `err` entirely — an
  // unexpected failure (pool exhaustion, snapshotMemberTrees fault, ...) left
  // zero server-side record of what actually broke.
  it('logs the original error before returning the generic message, matching readiness.ts', async () => {
    const db = await import('../db/index.js');
    const err = new Error('pg connection reset');
    vi.mocked(db.getReadinessReport).mockRejectedValue(err);
    const { logger } = await import('../lib/logger.js');
    const { handleReadinessReport } = await import('./readiness-handler.js');

    await handleReadinessReport({ specId: SPEC });

    expect(logger.error).toHaveBeenCalledWith({ err }, 'mcp tool readiness_report failed');
  });
});

describe('handleReadinessReport — package-scope aggregation survives the JSON round trip (INV-15)', () => {
  it('attributes each finding to its originating member spec after JSON.stringify/parse', async () => {
    const db = await import('../db/index.js');
    const specA = '30000000-0000-4000-8000-00000000000a';
    const specB = '30000000-0000-4000-8000-00000000000b';
    vi.mocked(db.getReadinessReport).mockResolvedValue({
      scope: { kind: 'package', packageId: PACKAGE },
      findings: [
        {
          type: 'specifier_note_present',
          nodeId: 'note-1',
          text: 'Coordinate with owner.',
          specId: specA,
          specSection: '26 05 02',
        },
        {
          type: 'open_comment',
          nodeId: 'comment-1',
          text: 'Verify substrate.',
          author: 'Jane',
          specId: specB,
          specSection: '08 11 03',
        },
      ],
      highlightAdvisory: [],
      summary: {
        unresolvedChoiceToken: 0,
        specifierNotePresent: 1,
        openComment: 1,
        bodyObjectPresent: 0,
        total: 2,
      },
      readyForFinal: false,
    });
    const { handleReadinessReport } = await import('./readiness-handler.js');

    const result = await handleReadinessReport({ packageId: PACKAGE });

    expect(result).not.toHaveProperty('isError');
    const parsed = JSON.parse(result.content[0]?.text ?? '') as {
      findings: readonly { nodeId: string; specId: string; specSection: string }[];
    };
    const byNodeId = new Map(parsed.findings.map((f) => [f.nodeId, f]));
    expect(byNodeId.get('note-1')).toMatchObject({ specId: specA, specSection: '26 05 02' });
    expect(byNodeId.get('comment-1')).toMatchObject({ specId: specB, specSection: '08 11 03' });
  });
});
