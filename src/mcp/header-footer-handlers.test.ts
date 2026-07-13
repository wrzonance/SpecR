// src/mcp/header-footer-handlers.test.ts
//
// Pins the "MCP tool handlers never throw" invariant for the header/footer
// CRUD tools' generic-error catch branch (#476 review finding): every
// run*HeaderFooter() wraps its DB call in try/catch and falls through to
// internalError() for anything that isn't a HeaderFooterValidationError or
// HeaderFooterScopeError. The integration suite only ever exercises
// semantic rejections (not-found, wrong-tier, malformed body) — never a
// plain/unexpected Error — so the internalError() branch itself (lines
// 84-118 of header-footer-handlers.ts) was previously unpinned.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  findHeaderFooterConfig: vi.fn(),
  upsertHeaderFooterConfig: vi.fn(),
  deleteHeaderFooterConfig: vi.fn(),
  findLibraryById: vi.fn(),
  HeaderFooterValidationError: class HeaderFooterValidationError extends Error {},
  HeaderFooterScopeError: class HeaderFooterScopeError extends Error {},
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
