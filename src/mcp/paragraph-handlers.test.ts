// src/mcp/paragraph-handlers.test.ts
//
// #583 (follow-up to #569/ADR-083, decided in ADR-085): the paragraph write
// tools' StaleVersionError/SpecWriteForbiddenError branches (shared via
// gateToolError across handleUpdateParagraph, handleInsertParagraph,
// handleRemoveParagraph and handleAcceptCommentAsNote) previously flattened
// both into prose only. Exercised here through handleUpdateParagraph — the
// shared function makes re-testing all four handlers redundant.
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ToolResult } from './tool-result.js';

// db/index.ts's barrel creates a real pg Pool at module load, so a plain
// import would need a live DATABASE_URL. Mock the barrel but re-export the
// real error classes (edit-gate.ts is type-only on 'pg' — safe to load) so
// `instanceof` checks in paragraph-handlers.ts see the same class references
// the test constructs errors from.
vi.mock('../db/index.js', async () => {
  const { SpecNotFoundError, SpecWriteForbiddenError, StaleVersionError } =
    await import('../db/queries/edit-gate.js');
  // The REAL message builder, not a hand-written stub: it is the string a
  // caller actually reads, so a stub here would let the two drift and leave
  // this test asserting against fiction (#383).
  const { invalidInsertTypeMessage } = await import('../db/queries/paragraph-insert.js');
  return {
    invalidInsertTypeMessage,
    SpecNotFoundError,
    SpecWriteForbiddenError,
    StaleVersionError,
    updateParagraphText: vi.fn(),
    setParagraphVanish: vi.fn(),
    acceptCommentAsNote: vi.fn(),
    insertParagraphAfter: vi.fn(),
    lockedObjectMessage: (nodeType: string) => `cannot edit "${nodeType}" directly`,
  };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = '10000000-0000-4000-8000-000000000004';
const NODE_ID = '10000000-0000-4000-8000-000000000005';

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function structuredContentOf(result: ToolResult): unknown {
  return 'structuredContent' in result ? result.structuredContent : undefined;
}

function hasStructuredContentKey(result: ToolResult): boolean {
  return 'structuredContent' in result;
}

describe('update_paragraph: stale version returns currentVersion as structuredContent alongside prose (#583)', () => {
  it('surfaces structuredContent.currentVersion matching the error class field', async () => {
    const { StaleVersionError, updateParagraphText } = await import('../db/index.js');
    const err = new StaleVersionError('stale write: expected version 3, current is 7', 7);
    vi.mocked(updateParagraphText).mockRejectedValueOnce(err);

    const { handleUpdateParagraph } = await import('./paragraph-handlers.js');
    const result = await handleUpdateParagraph({
      specId: SPEC_ID,
      nodeId: NODE_ID,
      text: 'new text',
      expectedVersion: 3,
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('stale version — current contentVersion is 7');
    expect(structuredContentOf(result)).toEqual({ currentVersion: 7 });

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

describe('insert_paragraph: rejects a cross-tier explicit nodeType via invalid-type (#383)', () => {
  it('surfaces the DB core invalid-type rejection as a toolError naming the rejected type', async () => {
    // insertSiblingRow's sibling-compatibility check (paragraph-insert.ts,
    // #383) rejects a pr1 requested after an article anchor — this pins that
    // the MCP handler's already-generic invalid-type branch surfaces it
    // without any handler-side change, at the mocked DB boundary.
    const { insertParagraphAfter } = await import('../db/index.js');
    vi.mocked(insertParagraphAfter).mockResolvedValueOnce({
      status: 'invalid-type',
      nodeType: 'pr1',
    });

    const { handleInsertParagraph } = await import('./paragraph-handlers.js');
    const result = await handleInsertParagraph({
      specId: SPEC_ID,
      anchorNodeId: NODE_ID,
      text: 'Should not become a mis-tiered pr1.',
      nodeType: 'pr1',
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('"pr1"');
    // The MCP surface must state the COMPLETE rule, exactly as REST does — the
    // two originally hand-copied a message omitting the tierless-anchor
    // exception, so an agent reading this rejection would conclude a legal
    // insert after a `note` anchor was illegal and "correct" a valid request.
    // Reachable only because the mock returns the real invalidInsertTypeMessage.
    expect(textOf(result)).toMatch(/tierless/i);
    expect(structuredContentOf(result)).toBeUndefined();
  });
});

describe('update_paragraph: write-forbidden has no structuredContent — REST 409 carries none either (#583)', () => {
  it('returns the message as prose with no structuredContent key', async () => {
    const { SpecWriteForbiddenError, updateParagraphText } = await import('../db/index.js');
    const err = new SpecWriteForbiddenError('spec is archived and cannot be edited');
    vi.mocked(updateParagraphText).mockRejectedValueOnce(err);

    const { handleUpdateParagraph } = await import('./paragraph-handlers.js');
    const result = await handleUpdateParagraph({
      specId: SPEC_ID,
      nodeId: NODE_ID,
      text: 'new text',
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
