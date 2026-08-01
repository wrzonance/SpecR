// src/mcp/header-footer-handlers.test.ts
//
// Pins the "MCP tool handlers never throw" invariant for the header/footer
// CRUD tools' generic-error catch branch (#476 review finding): every
// run*HeaderFooter() wraps its DB call in try/catch and falls through to
// internalError() for anything that isn't a HeaderFooterValidationError,
// HeaderFooterScopeError, or a pgErrorToHttp-classified pg error (#569).
// The integration suite only ever exercises semantic rejections (not-found,
// wrong-tier, malformed body) — never a plain/unexpected Error or a raw FK
// violation — so the internalError() branch and the 23503 classification
// branch were previously unpinned.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The 23503 classification relies on getPgCode(err) unwrapping a
// DatabaseError's cause (pg-errors.ts imports DatabaseError from this same
// mocked module and does an `instanceof` check), so the mock must export a
// real DatabaseError class — see src/mcp/assignment-handlers.test.ts for the
// same precedent.
vi.mock('../db/index.js', () => ({
  findHeaderFooterConfig: vi.fn(),
  upsertHeaderFooterConfig: vi.fn(),
  deleteHeaderFooterConfig: vi.fn(),
  findLibraryById: vi.fn(),
  HeaderFooterValidationError: class HeaderFooterValidationError extends Error {},
  HeaderFooterScopeError: class HeaderFooterScopeError extends Error {},
  DatabaseError: class DatabaseError extends Error {
    cause?: unknown;
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'DatabaseError';
      this.cause = options?.cause;
    }
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const LIBRARY_ID = '20000000-0000-4000-8000-000000000002';

const SAMPLE_CONFIG = {
  header: { center: { content: [{ kind: 'projectName' }] } },
  footer: { right: { content: [{ kind: 'pageNumber' }] } },
};

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

// Project scope exercises the plain runGet/runSet/runClearHeaderFooter path —
// no extra client-library guard — so it isolates the shared catch branch.
describe('project header/footer handlers — unexpected-error catch branch (#476)', () => {
  it('get: a non-HeaderFooter* rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.findHeaderFooterConfig).mockRejectedValueOnce(new Error('connection reset'));
    const { handleGetProjectHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleGetProjectHeaderFooter({ projectId: PROJECT_ID });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('Internal error');
  });

  it('set: a non-HeaderFooter* rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.upsertHeaderFooterConfig).mockRejectedValueOnce(new Error('connection reset'));
    const { handleSetProjectHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleSetProjectHeaderFooter({
      projectId: PROJECT_ID,
      config: SAMPLE_CONFIG,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('Internal error');
  });

  it('clear: a non-HeaderFooter* rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.deleteHeaderFooterConfig).mockRejectedValueOnce(new Error('connection reset'));
    const { handleClearProjectHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleClearProjectHeaderFooter({ projectId: PROJECT_ID });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('Internal error');
  });
});

// Client (library) scope runs requireClientLibrary() ahead of the write —
// once that guard passes, the write itself can still reject unexpectedly,
// which is a distinct code path from the pre-guard "library not found" case
// already covered by the integration suite.
describe('client-scope header/footer handlers — unexpected-error catch branch (#476)', () => {
  it('set: guard passes, then an unexpected write rejection surfaces as Internal error', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.findLibraryById).mockResolvedValueOnce({
      id: LIBRARY_ID,
      tier: 'client',
    } as never);
    vi.mocked(db.upsertHeaderFooterConfig).mockRejectedValueOnce(new Error('connection reset'));
    const { handleSetLibraryHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleSetLibraryHeaderFooter({
      libraryId: LIBRARY_ID,
      config: SAMPLE_CONFIG,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('Internal error');
  });

  it('clear: guard passes, then an unexpected delete rejection surfaces as Internal error', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.findLibraryById).mockResolvedValueOnce({
      id: LIBRARY_ID,
      tier: 'client',
    } as never);
    vi.mocked(db.deleteHeaderFooterConfig).mockRejectedValueOnce(new Error('connection reset'));
    const { handleClearLibraryHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleClearLibraryHeaderFooter({ libraryId: LIBRARY_ID });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('Internal error');
  });
});

// #569: a nonexistent project/package/revision scope id must surface the
// same "referenced scope not found" class of error the REST route returns
// (src/api/header-footer.ts's mapWriteError on a 23503 FK violation), not a
// generic "Internal error" that hides a typo'd id behind a retry-worthy
// server-fault message.
describe('header/footer handlers — scope-not-found (23503) surfaces as a classified error, not internal (#569)', () => {
  function fkViolation(): Error {
    return Object.assign(new Error('fk violation'), { code: '23503' });
  }

  it('set_project_header_footer: nonexistent project id → "referenced scope not found", not Internal error', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.upsertHeaderFooterConfig).mockRejectedValueOnce(
      new db.DatabaseError('upsertHeaderFooterConfig failed', { cause: fkViolation() })
    );
    const { handleSetProjectHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleSetProjectHeaderFooter({
      projectId: PROJECT_ID,
      config: SAMPLE_CONFIG,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('referenced scope not found');
    expect(textOf(result)).not.toContain('Internal error');
  });

  it('set_package_header_footer: nonexistent package id → "referenced scope not found", not Internal error', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.upsertHeaderFooterConfig).mockRejectedValueOnce(
      new db.DatabaseError('upsertHeaderFooterConfig failed', { cause: fkViolation() })
    );
    const { handleSetPackageHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleSetPackageHeaderFooter({
      packageId: PROJECT_ID,
      config: SAMPLE_CONFIG,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('referenced scope not found');
  });

  it('set_revision_header_footer: nonexistent revision id → "referenced scope not found", not Internal error', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.upsertHeaderFooterConfig).mockRejectedValueOnce(
      new db.DatabaseError('upsertHeaderFooterConfig failed', { cause: fkViolation() })
    );
    const { handleSetRevisionHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleSetRevisionHeaderFooter({
      revisionId: PROJECT_ID,
      config: SAMPLE_CONFIG,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('referenced scope not found');
  });

  it('a non-23503 pg error (e.g. 23514) still surfaces its classified message, not Internal error', async () => {
    const db = await import('../db/index.js');
    const pgErr = Object.assign(new Error('check violation'), { code: '23514' });
    vi.mocked(db.upsertHeaderFooterConfig).mockRejectedValueOnce(
      new db.DatabaseError('upsertHeaderFooterConfig failed', { cause: pgErr })
    );
    const { handleSetProjectHeaderFooter } = await import('./header-footer-handlers.js');

    const result = await handleSetProjectHeaderFooter({
      projectId: PROJECT_ID,
      config: SAMPLE_CONFIG,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).not.toContain('Internal error');
  });
});
