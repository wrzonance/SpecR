import { describe, it, expect } from 'vitest';
import { deriveArticleRole, tagArticleRoles } from './article-role.js';
import type { SpecNode } from './types.js';

function article(text: string, children: readonly SpecNode[] = []): SpecNode {
  return { id: 'a', type: 'article', text, children, meta: {} };
}

describe('deriveArticleRole — canonical CSI headings', () => {
  it('classifies bare canonical headings', () => {
    expect(deriveArticleRole('RELATED SECTIONS')).toBe('related-sections');
    expect(deriveArticleRole('REFERENCES')).toBe('references');
    expect(deriveArticleRole('SUBMITTALS')).toBe('submittals');
    expect(deriveArticleRole('SUMMARY')).toBe('summary');
    expect(deriveArticleRole('QUALITY ASSURANCE')).toBe('quality-assurance');
    expect(deriveArticleRole('DEFINITIONS')).toBe('definitions');
    expect(deriveArticleRole('WARRANTY')).toBe('warranty');
    expect(deriveArticleRole('DELIVERY, STORAGE AND HANDLING')).toBe('delivery-storage-handling');
  });

  it('tolerates a leading CSI numbering prefix (ARCAT "1.1 X" form)', () => {
    expect(deriveArticleRole('1.1 RELATED SECTIONS')).toBe('related-sections');
    expect(deriveArticleRole('1.3 SUBMITTALS')).toBe('submittals');
  });

  it('tolerates a CPI-style numbering prefix and offset (same logical article)', () => {
    // CPI reserves low ilvls for Schedule/PDS; the inference engine normalizes
    // the offset into node_type='article' before the deriver runs, so the only
    // thing the deriver sees is the heading text — prefix or not, it classifies.
    expect(deriveArticleRole('1.02 REFERENCES')).toBe('references');
    expect(deriveArticleRole('REFERENCES')).toBe('references');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(deriveArticleRole('  related   sections ')).toBe('related-sections');
    expect(deriveArticleRole('References')).toBe('references');
  });

  it('strips the numbering prefix even behind incidental leading whitespace', () => {
    // The prefix regex is ^-anchored; normalizeHeading trims before stripping so
    // a leading space ("  1.1 REFERENCES") does not block the strip and leave an
    // unmatchable "1.1 REFERENCES" behind.
    expect(deriveArticleRole('  1.1 REFERENCES')).toBe('references');
    expect(deriveArticleRole('\t1.02 SUBMITTALS')).toBe('submittals');
    // The 3D anchor still holds with leading whitespace — never strips into a role.
    expect(deriveArticleRole('  3D MODELING')).toBeUndefined();
  });

  it('accepts documented variants', () => {
    expect(deriveArticleRole('RELATED REQUIREMENTS')).toBe('related-sections');
    expect(deriveArticleRole('REFERENCE STANDARDS')).toBe('references');
    expect(deriveArticleRole('1.4 RELATED WORK')).toBe('related-sections');
  });

  it('returns undefined for unknown/non-standard headings (never a wrong role)', () => {
    expect(deriveArticleRole('SYSTEM DESCRIPTION')).toBeUndefined();
    expect(deriveArticleRole('PERFORMANCE REQUIREMENTS')).toBeUndefined();
    expect(deriveArticleRole('')).toBeUndefined();
    expect(deriveArticleRole('1.7 MAINTENANCE')).toBeUndefined();
  });

  it('prefix strip: a digit glued to a letter is not a numbering prefix (3D ≠ "D…")', () => {
    // The numbering-prefix strip requires a separator or whitespace terminator,
    // so "3D" / "2024" tokens stay intact and never accidentally expose a role.
    expect(deriveArticleRole('3D MODELING')).toBeUndefined();
    expect(deriveArticleRole('2024 REQUIREMENTS')).toBeUndefined();
  });

  it('prefix strip: only a dotted CSI article number is stripped — a bare integer/year before a real title is not (never a wrong role)', () => {
    // CSI article numbers are dotted ("1.1", "1.02"); a bare integer or year is
    // NOT one. Stripping it would expose a role for a non-CSI heading, violating
    // the "absent rather than wrong" contract. "2024 REFERENCES"/"1 REFERENCES"
    // must derive NO role even though "REFERENCES" alone would.
    expect(deriveArticleRole('2024 REFERENCES')).toBeUndefined();
    expect(deriveArticleRole('1 REFERENCES')).toBeUndefined();
    expect(deriveArticleRole('1 SUMMARY')).toBeUndefined();
    // The dotted CSI forms still classify.
    expect(deriveArticleRole('1.1 REFERENCES')).toBe('references');
    expect(deriveArticleRole('1.1.1 REFERENCES')).toBe('references');
  });

  // KNOWN AMBIGUITY: "REFERENCES" as a sub-list heading inside another article
  // (e.g. a manufacturer's reference drawings) reads identically to the PART-1
  // References article. The deriver classifies on heading text alone and cannot
  // see nesting depth, so it WILL tag such a heading 'references'. Callers that
  // need PART-1-only roles must filter by tree position; the deriver does not
  // guess position. Asserted here so the behavior is explicit, not silent.
  it('KNOWN AMBIGUITY: a nested "REFERENCES" heading also classifies as references', () => {
    expect(deriveArticleRole('REFERENCES')).toBe('references');
  });
});

describe('tagArticleRoles — immutable tree transform', () => {
  it('sets meta.articleRole on matching article nodes only', () => {
    const input: readonly SpecNode[] = [
      {
        id: 'p1',
        type: 'part',
        text: 'GENERAL',
        meta: {},
        children: [
          article('REFERENCES'),
          article('SYSTEM DESCRIPTION'),
          { id: 'n', type: 'note', text: 'REFERENCES', children: [], meta: {} },
        ],
      },
    ];
    const out = tagArticleRoles(input);
    const part = out[0];
    expect(part?.children[0]?.meta.articleRole).toBe('references');
    expect(part?.children[1]?.meta.articleRole).toBeUndefined();
    // note node with "REFERENCES" text is NOT a role-bearing article
    expect(part?.children[2]?.meta.articleRole).toBeUndefined();
  });

  it('does not mutate the input (immutability)', () => {
    const input: readonly SpecNode[] = [article('REFERENCES')];
    const out = tagArticleRoles(input);
    expect(input[0]?.meta.articleRole).toBeUndefined();
    expect(out[0]?.meta.articleRole).toBe('references');
    expect(out).not.toBe(input);
  });

  it('preserves existing meta fields when adding the role', () => {
    const input: readonly SpecNode[] = [
      { id: 'a', type: 'article', text: 'REFERENCES', children: [], meta: { vanish: true } },
    ];
    const out = tagArticleRoles(input);
    expect(out[0]?.meta.vanish).toBe(true);
    expect(out[0]?.meta.articleRole).toBe('references');
  });
});

import * as astBarrel from './index.js';

describe('ast barrel re-exports', () => {
  it('exposes the deriver and tree transform', () => {
    expect(typeof astBarrel.deriveArticleRole).toBe('function');
    expect(typeof astBarrel.tagArticleRoles).toBe('function');
    expect(Array.isArray(astBarrel.ARTICLE_ROLE_RULES)).toBe(true);
  });
});
