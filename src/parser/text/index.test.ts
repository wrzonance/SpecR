import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseText } from './index.js';
import type { SpecNode } from '../../ast/types.js';

describe('parseText — numbered-prefixes fixture', () => {
  const fixture = readFileSync(join('tests', 'fixtures', 'text', 'numbered-prefixes.txt'), 'utf-8');

  it('returns read-only capability', () => {
    const result = parseText(fixture);
    expect(result.capabilities).toContain('read-only');
  });

  it('extracts section from SECTION header line', () => {
    const result = parseText(fixture);
    expect(result.tree.section).toBe('03 30 00');
  });

  it('extracts title from SECTION header line', () => {
    const result = parseText(fixture);
    expect(result.tree.title).toMatch(/CAST-IN-PLACE CONCRETE/i);
  });

  it('returns 3 part nodes', () => {
    const result = parseText(fixture);
    expect(result.tree.parts).toHaveLength(3);
  });

  it('part nodes have correct text (prefix stripped)', () => {
    const result = parseText(fixture);
    expect(result.tree.parts[0]?.text).toBe('GENERAL');
    expect(result.tree.parts[1]?.text).toBe('PRODUCTS');
    expect(result.tree.parts[2]?.text).toBe('EXECUTION');
  });

  it('each part has article children', () => {
    const result = parseText(fixture);
    const part1 = result.tree.parts[0];
    expect(part1?.children.length).toBeGreaterThanOrEqual(2);
    expect(part1?.children.every((c) => c.type === 'article')).toBe(true);
  });

  it('pr1 nodes exist under articles with prefix stripped', () => {
    const result = parseText(fixture);
    const part1 = result.tree.parts[0]!;
    const article = part1.children[0]!;
    const pr1 = article.children.find((c) => c.type === 'pr1');
    expect(pr1).toBeDefined();
    expect(pr1?.text).not.toMatch(/^[A-Z]\.\s/); // prefix must be stripped
  });

  it('refs array is empty', () => {
    const result = parseText(fixture);
    expect(result.refs).toHaveLength(0);
  });

  it('all node ids are unique UUIDs', () => {
    const ids: string[] = [];
    function collect(nodes: readonly SpecNode[]): void {
      for (const n of nodes) {
        ids.push(n.id);
        collect(n.children);
      }
    }
    const result = parseText(fixture);
    result.tree.parts.forEach((p) => {
      ids.push(p.id);
      collect(p.children);
    });
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe('parseText — UFGS stripped fixture', () => {
  const fixture = readFileSync(join('tests', 'fixtures', 'text', 'ufgs-27-10-00.txt'), 'utf-8');

  it('returns read-only capability', () => {
    expect(parseText(fixture).capabilities).toContain('read-only');
  });

  it('infers section 27 10 00', () => {
    expect(parseText(fixture).tree.section).toBe('27 10 00');
  });

  it('produces at least 1 part node', () => {
    expect(parseText(fixture).tree.parts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseText — indent-only fixture', () => {
  const fixture = readFileSync(join('tests', 'fixtures', 'text', 'indent-only.txt'), 'utf-8');

  it('returns read-only capability', () => {
    expect(parseText(fixture).capabilities).toContain('read-only');
  });

  it('produces part nodes', () => {
    expect(parseText(fixture).tree.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('continuation nodes exist under articles', () => {
    const result = parseText(fixture);
    const part1 = result.tree.parts[0]!;
    const article = part1.children[0]!;
    const cont = article.children.find((c) => c.type === 'continuation');
    expect(cont).toBeDefined();
  });
});

describe('parseText — section extraction edge cases', () => {
  it('returns unknown section when no SECTION line present', () => {
    const result = parseText('PART 1 - GENERAL\n1.1 SCOPE\nSome text.\n');
    expect(result.tree.section).toBe('unknown');
  });

  it('handles CRLF line endings', () => {
    const result = parseText('SECTION 27 21 00\r\nPART 1 - GENERAL\r\n');
    expect(result.tree.section).toBe('27 21 00');
  });

  it('infers section from bare numbers when no SECTION header present', () => {
    // extractSectionMeta matches a bare "XX XX XX" line (BARE_SECTION_RE) as
    // a fallback when no "SECTION XX XX XX" header is found.
    const result = parseText('27 10 00\nPART 1 - GENERAL\n1.1 SCOPE\nSome text.\n');
    expect(result.tree.section).toBe('27 10 00');
  });

  it('skips continuation lines before first structural element', () => {
    const result = parseText('Some prose before any PART\nPART 1 - GENERAL\n1.1 SCOPE\n');
    expect(result.tree.parts.every((p) => p.type === 'part')).toBe(true);
    expect(result.tree.parts).toHaveLength(1);
  });
});
