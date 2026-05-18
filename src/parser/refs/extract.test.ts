import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { extractRefsFromTree } from './extract.js';
import type { SpecNode, SpecTree } from '../../ast/types.js';

function makeNode(
  type: SpecNode['type'],
  text: string,
  children: readonly SpecNode[] = []
): SpecNode {
  return { id: uuidv4(), type, text, children, meta: {} };
}

function treeWith(parts: readonly SpecNode[]): SpecTree {
  return { id: uuidv4(), section: '27 41 00', title: 'TEST', parts };
}

describe('extractRefsFromTree', () => {
  it('extracts section refs: "See Section 09 91 00"', () => {
    const node = makeNode('pr1', 'See Section 09 91 00 for paint.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const sectionRefs = refs.filter((r) => r.targetType === 'section');
    expect(sectionRefs).toHaveLength(1);
    expect(sectionRefs[0]?.targetSpecSection).toBe('09 91 00');
    expect(sectionRefs[0]?.sourceNodeId).toBe(node.id);
    expect(sectionRefs[0]?.referenceText).toMatch(/Section\s+09\s+91\s+00/);
  });

  it('extracts ASTM standard: "Comply with ASTM C150"', () => {
    const node = makeNode('pr1', 'Comply with ASTM C150 throughout.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const standardRefs = refs.filter((r) => r.targetType === 'standard');
    expect(standardRefs).toHaveLength(1);
    expect(standardRefs[0]?.standardCode).toBe('ASTM C150');
    expect(standardRefs[0]?.sourceNodeId).toBe(node.id);
  });

  it('extracts multiple orgs in same node: NFPA 70 and IEEE 802.3', () => {
    const node = makeNode('pr1', 'Per NFPA 70 and IEEE 802.3, install per code.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const codes = refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode);
    expect(codes).toContain('NFPA 70');
    expect(codes).toContain('IEEE 802.3');
  });

  it('extracts both section and standard refs from same node', () => {
    const node = makeNode('pr1', 'See Section 09 91 00 and comply with ASTM C150.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    expect(refs.some((r) => r.targetType === 'section')).toBe(true);
    expect(refs.some((r) => r.targetType === 'standard')).toBe(true);
  });

  it('walks nested children: ref in pr3 returns with correct sourceNodeId', () => {
    const pr3 = makeNode('pr3', 'Per ASTM C150 cement.');
    const pr1 = makeNode('pr1', 'Materials.', [pr3]);
    const article = makeNode('article', '1.1 SCOPE', [pr1]);
    const part = makeNode('part', 'PART 1', [article]);
    const tree = treeWith([part]);
    const refs = extractRefsFromTree(tree);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.sourceNodeId).toBe(pr3.id);
  });

  it('case-insensitive section match: lowercase "section 09 91 00"', () => {
    const node = makeNode('pr1', 'see section 09 91 00 for details.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    expect(refs.filter((r) => r.targetType === 'section')).toHaveLength(1);
  });

  it('empty tree (parts: []) → empty refs array', () => {
    const refs = extractRefsFromTree(treeWith([]));
    expect(refs).toEqual([]);
  });

  it('preserves sourceNodeId across all rule types', () => {
    const node = makeNode('pr1', 'See Section 09 91 00, comply with ASTM C150.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    expect(refs.every((r) => r.sourceNodeId === node.id)).toBe(true);
  });

  it('caller-provided non-global rule: coerced to global, does not throw', () => {
    const nonGlobalRule = {
      id: 'test-non-global',
      description: 'non-global pattern',
      pattern: /\bASTM\s+([A-Z]\d+)\b/i,
      targetType: 'standard' as const,
      examples: ['ASTM C150'],
    };
    const node = makeNode('pr1', 'See ASTM C150 and ASTM A615 both.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree, [nonGlobalRule]);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.referenceText)).toEqual(['ASTM C150', 'ASTM A615']);
  });

  it('rules parameter override: empty rules array → no refs', () => {
    const node = makeNode('pr1', 'See Section 09 91 00 and ASTM C150.');
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree, []);
    expect(refs).toEqual([]);
  });

  it('handles all 11 supported orgs', () => {
    const text =
      'Refs: ASTM C150, ANSI 100, IEEE 802.3, NFPA 70, UL 94, ' +
      'NEMA WC-70, NEC 250, TIA 568, BICSI 002, ASME B31.1, ASHRAE 90.1.';
    const node = makeNode('pr1', text);
    const tree = treeWith([makeNode('part', 'PART 1', [node])]);
    const refs = extractRefsFromTree(tree);
    const orgs = new Set(
      refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode?.split(' ')[0])
    );
    for (const expected of [
      'ASTM',
      'ANSI',
      'IEEE',
      'NFPA',
      'UL',
      'NEMA',
      'NEC',
      'TIA',
      'BICSI',
      'ASME',
      'ASHRAE',
    ]) {
      expect(orgs).toContain(expected);
    }
  });
});
