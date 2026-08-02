// src/mcp/merge-handlers.test.ts
//
// #583 (follow-up to #569/ADR-083, decided in ADR-084): apply_merge's
// StaleVersionError/SpecWriteForbiddenError branches previously flattened
// both into prose only. StaleVersionError now surfaces `currentVersion` as
// structuredContent — mirroring both the error class's own field and REST's
// gateErrorResponse 409 body (src/api/edit-gate-response.ts) field-for-field
// — while SpecWriteForbiddenError stays prose-only, matching that REST body
// having nothing beyond `error` for that class.
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ToolResult } from './tool-result.js';

// db/index.ts's barrel creates a real pg Pool at module load, so a plain
// import would need a live DATABASE_URL. Mock the barrel but re-export the
// real error classes (edit-gate.ts is type-only on 'pg' — safe to load) so
// `instanceof` checks in merge-handlers.ts see the same class references
// the test constructs errors from.
vi.mock('../db/index.js', async () => {
  const { SpecNotFoundError, SpecWriteForbiddenError, StaleVersionError } =
    await import('../db/queries/edit-gate.js');
  return { SpecNotFoundError, SpecWriteForbiddenError, StaleVersionError };
});

vi.mock('../merge/index.js', async () => {
  const { MergeError } = await import('../merge/error.js');
  const { InvalidAcceptedChangeError } = await import('../merge/conflict.js');
  return { applyMerge: vi.fn(), InvalidAcceptedChangeError, MergeError };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = '10000000-0000-4000-8000-000000000002';
const PARAGRAPH_ID = '10000000-0000-4000-8000-000000000003';

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function structuredContentOf(result: ToolResult): unknown {
  return 'structuredContent' in result ? result.structuredContent : undefined;
}

function hasStructuredContentKey(result: ToolResult): boolean {
  return 'structuredContent' in result;
}

const DIFF = {
  added: [],
  modified: [],
  deleted: [],
  conflicts: [],
  objectConflicts: [],
  warnings: [],
};

describe('apply_merge: stale version returns currentVersion as structuredContent alongside prose (#583)', () => {
  it('surfaces structuredContent.currentVersion matching the error class field', async () => {
    const { StaleVersionError } = await import('../db/index.js');
    const { applyMerge } = await import('../merge/index.js');
    const err = new StaleVersionError('stale write: expected version 5, current is 9', 9);
    vi.mocked(applyMerge).mockRejectedValueOnce(err);

    const { handleApplyMerge } = await import('./merge-handlers.js');
    const result = await handleApplyMerge({
      specId: SPEC_ID,
      accept: [PARAGRAPH_ID],
      diff: DIFF,
      expectedVersion: 5,
    });

    expect(result).toMatchObject({ isError: true });
    // Full message, not a substring — pins the trailing guidance clause too
    // (merge-handlers.ts:16), not just the version-number prefix.
    expect(textOf(result)).toBe(
      'stale version — current contentVersion is 9; re-run get_spec_diff and retry'
    );
    expect(structuredContentOf(result)).toEqual({ currentVersion: 9 });

    // Cross-check against the actual REST gateErrorResponse (src/api/edit-gate-
    // response.ts) on the SAME error instance — pins the parity claim against
    // the real function, not just a hardcoded duplicate literal that could
    // drift from it unnoticed.
    const { gateErrorResponse } = await import('../api/edit-gate-response.js');
    const rest = gateErrorResponse(err);
    expect(rest?.status).toBe(409);
    expect(structuredContentOf(result)).toEqual({ currentVersion: rest?.body.currentVersion });
  });
});

describe('apply_merge: write-forbidden has no structuredContent — REST 409 carries none either (#583)', () => {
  it('returns the message as prose with no structuredContent key', async () => {
    const { SpecWriteForbiddenError } = await import('../db/index.js');
    const { applyMerge } = await import('../merge/index.js');
    const err = new SpecWriteForbiddenError('spec is archived and cannot be edited');
    vi.mocked(applyMerge).mockRejectedValueOnce(err);

    const { handleApplyMerge } = await import('./merge-handlers.js');
    const result = await handleApplyMerge({
      specId: SPEC_ID,
      accept: [PARAGRAPH_ID],
      diff: DIFF,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('spec is archived and cannot be edited');
    expect(structuredContentOf(result)).toBeUndefined();
    expect(hasStructuredContentKey(result)).toBe(false);

    // Cross-check against the actual REST gateErrorResponse on the SAME error
    // instance: confirm its 409 body genuinely carries nothing beyond `error`
    // for this class, rather than trusting a comment that it does.
    const { gateErrorResponse } = await import('../api/edit-gate-response.js');
    const rest = gateErrorResponse(err);
    expect(rest?.status).toBe(409);
    expect(Object.keys(rest?.body ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'error',
      'success',
    ]);
  });
});
