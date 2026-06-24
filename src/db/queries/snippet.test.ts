import { describe, it, expect } from 'vitest';
import { buildSnippet } from './snippet.js';

describe('buildSnippet', () => {
  it('returns the whole paragraph when it is within the window budget', () => {
    const text = 'Coordinate with Section 07 84 00 Firestopping.';
    expect(buildSnippet(text, 'Section 07 84 00')).toBe(text);
  });

  it('trims and collapses internal whitespace so the snippet reads as one line', () => {
    const text = '   Coordinate   with\n\tSection 07 84 00   Firestopping.  ';
    expect(buildSnippet(text, 'Section 07 84 00')).toBe(
      'Coordinate with Section 07 84 00 Firestopping.'
    );
  });

  it('windows a long paragraph around the match with a leading and trailing ellipsis', () => {
    const before = 'a'.repeat(200);
    const after = 'b'.repeat(200);
    const text = `${before} Section 07 84 00 ${after}`;
    const snippet = buildSnippet(text, 'Section 07 84 00');

    expect(snippet).toContain('Section 07 84 00');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(text.length);
  });

  it('does not add a leading ellipsis when the match sits at the paragraph start', () => {
    const text = `Section 07 84 00 ${'b'.repeat(300)}`;
    const snippet = buildSnippet(text, 'Section 07 84 00');

    expect(snippet.startsWith('Section 07 84 00')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('does not add a trailing ellipsis when the match sits at the paragraph end', () => {
    const text = `${'a'.repeat(300)} Section 07 84 00`;
    const snippet = buildSnippet(text, 'Section 07 84 00');

    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('Section 07 84 00')).toBe(true);
  });

  it('falls back to a head window when the match text is absent from the paragraph', () => {
    // Defensive: reference_text and paragraph text are stored independently, so a
    // mismatch is possible. Return a readable head excerpt rather than nothing.
    const text = 'x'.repeat(300);
    const snippet = buildSnippet(text, 'Section 99 99 99');

    expect(snippet.startsWith('x')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('matches the reference text case-insensitively', () => {
    const text = `${'a'.repeat(300)} see section 07 84 00 for details ${'b'.repeat(300)}`;
    const snippet = buildSnippet(text, 'SECTION 07 84 00');

    expect(snippet.toLowerCase()).toContain('section 07 84 00');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });
});
