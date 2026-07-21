import { describe, it, expect } from 'vitest';
import { LETTER_PAGE_SIZE, resolvePageSize, toDocxPageSize } from './page-size.js';
import type { PageSize } from '../ast/index.js';

// #509: resolvePageSize is the single default-to-Letter path shared by every
// generator call site (generateDocx, generateManual per-tree, generateManual
// front-matter). Pinned here as a pure boundary invariant so no call site can
// special-case its own fallback.
describe('resolvePageSize', () => {
  it('returns LETTER_PAGE_SIZE when pageSize is undefined', () => {
    expect(resolvePageSize(undefined)).toEqual(LETTER_PAGE_SIZE);
  });

  it('returns the captured pageSize unchanged when present', () => {
    const captured: PageSize = { width: 16838, height: 11906, orientation: 'landscape' };
    expect(resolvePageSize(captured)).toEqual(captured);
  });

  it('returns a captured pageSize with no orientation unchanged (never fabricates one)', () => {
    const captured: PageSize = { width: 12240, height: 15840 };
    const resolved = resolvePageSize(captured);
    expect(resolved).toEqual(captured);
    expect(resolved.orientation).toBeUndefined();
  });

  it('never returns a partial shape — width and height are always present', () => {
    for (const input of [undefined, { width: 12240, height: 15840 }] as const) {
      const resolved = resolvePageSize(input);
      expect(typeof resolved.width).toBe('number');
      expect(typeof resolved.height).toBe('number');
    }
  });
});

// #509: dolanmiu/docx's own createPageSize swaps width/height whenever
// orientation is 'landscape' — its width/height are the page's *reference*
// (portrait-style) dimensions, not the physically rendered ones. A captured
// PageSize's width/height are always the literal w:pgSz/@w:w / @w:h values,
// so passing them straight into docx's `page.size` would be swapped a
// second time. toDocxPageSize cancels that swap up front.
describe('toDocxPageSize', () => {
  it('passes portrait dimensions through unchanged', () => {
    expect(toDocxPageSize({ width: 12240, height: 15840, orientation: 'portrait' })).toEqual({
      width: 12240,
      height: 15840,
      orientation: 'portrait',
    });
  });

  it('pre-swaps width/height for landscape, so docx’s own swap reproduces the captured w:w/w:h verbatim', () => {
    // A physically landscape page: captured w:w=15840 (wide), w:h=12240 (tall).
    const captured: PageSize = { width: 15840, height: 12240, orientation: 'landscape' };
    expect(toDocxPageSize(captured)).toEqual({
      width: 12240,
      height: 15840,
      orientation: 'landscape',
    });
  });

  it('leaves width/height untouched when orientation is absent (no swap without an explicit landscape flag)', () => {
    expect(toDocxPageSize({ width: 12240, height: 15840 })).toEqual({
      width: 12240,
      height: 15840,
    });
  });
});
