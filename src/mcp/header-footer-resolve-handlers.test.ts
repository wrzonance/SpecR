// src/mcp/header-footer-resolve-handlers.test.ts
//
// Pins the "MCP tool handlers never throw" invariant for the header/footer
// resolve tools' generic-error catch branch (#476 review finding):
// runResolveHeaderFooter() falls through to internalError() for anything
// that isn't a HeaderFooterScopeError. The integration suite never forces
// resolveHeaderFooterConfig to reject with a plain/unexpected Error, so
// lines 42-61 of header-footer-resolve-handlers.ts were previously unpinned.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// header-footer-resolve-handlers.ts re-exports Shape objects from
// header-footer-handlers.js, which itself imports from '../db/index.js' —
// so the mock factory must cover both modules' DB dependencies, not just
// resolveHeaderFooterConfig.
vi.mock('../db/index.js', () => ({
  resolveHeaderFooterConfig: vi.fn(),
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

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

// Project scope exercises the shared runResolveHeaderFooter() path — the
// same function backs package/revision, so a single scope pins the branch.
describe('resolve header/footer handlers — unexpected-error catch branch (#476)', () => {
  it('a non-HeaderFooterScopeError rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.resolveHeaderFooterConfig).mockRejectedValueOnce(new Error('connection reset'));
    const { handleResolveProjectHeaderFooter } =
      await import('./header-footer-resolve-handlers.js');

    const result = await handleResolveProjectHeaderFooter({ projectId: PROJECT_ID });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('Internal error');
  });
});
