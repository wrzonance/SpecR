// src/mcp/paragraph-handlers.test.ts
//
// #583 (follow-up to #569/ADR-083, decided in ADR-084): the paragraph write
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
  return {
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
    vi.mocked(updateParagraphText).mockRejectedValueOnce(
      new StaleVersionError('stale write: expected version 3, current is 7', 7)
    );

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
  });
});

describe('update_paragraph: write-forbidden has no structuredContent — REST 409 carries none either (#583)', () => {
  it('returns the message as prose with no structuredContent key', async () => {
    const { SpecWriteForbiddenError, updateParagraphText } = await import('../db/index.js');
    vi.mocked(updateParagraphText).mockRejectedValueOnce(
      new SpecWriteForbiddenError('spec is archived and cannot be edited')
    );

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
  });
});
