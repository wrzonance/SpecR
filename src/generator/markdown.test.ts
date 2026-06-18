import { describe, it, expect } from 'vitest';
import { getLabel, renderMarkdown } from './markdown.js';
import type { SpecTree } from '../ast/types.js';

describe('getLabel', () => {
  it('labels parts', () => {
    expect(getLabel('part', 0)).toBe('PART 1 -');
    expect(getLabel('part', 2)).toBe('PART 3 -');
  });
  it('labels articles with part number', () => {
    expect(getLabel('article', 0, 1)).toBe('1.1');
    expect(getLabel('article', 2, 2)).toBe('2.3');
  });
  it('labels pr1 A. B. C.', () => {
    expect(getLabel('pr1', 0)).toBe('A.');
    expect(getLabel('pr1', 25)).toBe('Z.');
  });
  it('labels pr2 1. 2. 3.', () => {
    expect(getLabel('pr2', 0)).toBe('1.');
    expect(getLabel('pr2', 2)).toBe('3.');
  });
  it('labels pr3 a. b. c.', () => {
    expect(getLabel('pr3', 0)).toBe('a.');
    expect(getLabel('pr3', 2)).toBe('c.');
  });
  it('labels pr4 1) 2) 3)', () => {
    expect(getLabel('pr4', 0)).toBe('1)');
    expect(getLabel('pr4', 3)).toBe('4)');
  });
  it('labels pr5 a) b)', () => {
    expect(getLabel('pr5', 0)).toBe('a)');
    expect(getLabel('pr5', 1)).toBe('b)');
  });
  it('labels pr6/pr7 with repeated paren tiers', () => {
    expect(getLabel('pr6', 0)).toBe('1)');
    expect(getLabel('pr7', 1)).toBe('b)');
  });
  it('returns empty for non-numbered types', () => {
    expect(getLabel('spec', 0)).toBe('');
    expect(getLabel('note', 0)).toBe('');
    expect(getLabel('continuation', 0)).toBe('');
  });
});

const TREE: SpecTree = {
  id: '00000000-0000-0000-0000-000000000001',
  section: '27 21 00',
  title: 'Structured Cabling',
  parts: [
    {
      id: '00000000-0000-0000-0000-000000000002',
      type: 'part',
      text: 'GENERAL',
      children: [
        {
          id: '00000000-0000-0000-0000-000000000003',
          type: 'article',
          text: 'REFERENCES',
          children: [
            {
              id: '00000000-0000-0000-0000-000000000004',
              type: 'pr1',
              text: 'Coordinate work of all trades.',
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000006',
                  type: 'pr2',
                  text: 'Include cable routing plans.',
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
            {
              id: '00000000-0000-0000-0000-000000000005',
              type: 'note',
              text: 'Edit for local conditions.',
              children: [],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
      meta: {},
    },
  ],
};

describe('renderMarkdown', () => {
  it('renders full TREE fixture exactly', () => {
    expect(renderMarkdown(TREE)).toBe(
      '# SECTION 27 21 00 — Structured Cabling\n' +
        '\n## PART 1 - GENERAL\n' +
        '\n### 1.1 REFERENCES\n' +
        '\nA. Coordinate work of all trades.' +
        '\n   1. Include cable routing plans.' +
        '\n> **[NOTE]** Edit for local conditions.'
    );
  });
  it('renders section heading', () => {
    expect(renderMarkdown(TREE)).toContain('# SECTION 27 21 00 — Structured Cabling');
  });
  it('renders part heading', () => {
    expect(renderMarkdown(TREE)).toContain('## PART 1 - GENERAL');
  });
  it('renders article heading', () => {
    expect(renderMarkdown(TREE)).toContain('### 1.1 REFERENCES');
  });
  it('renders pr1 label', () => {
    expect(renderMarkdown(TREE)).toContain('A. Coordinate work of all trades.');
  });
  it('renders pr2 label indented', () => {
    expect(renderMarkdown(TREE)).toContain('   1. Include cable routing plans.');
  });
  it('renders note as blockquote by type, not by vanish flag', () => {
    expect(renderMarkdown(TREE)).toContain('> **[NOTE]** Edit for local conditions.');
  });
  it('suppresses pr1 with meta.vanish — returns empty, not rendered', () => {
    const treeWithVanish: SpecTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '27 21 00',
      title: 'Vanish Test',
      parts: [
        {
          id: '00000000-0000-0000-0000-000000000002',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '00000000-0000-0000-0000-000000000003',
              type: 'article',
              text: 'SCOPE',
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000004',
                  type: 'pr1',
                  text: 'Hidden paragraph.',
                  children: [],
                  meta: { vanish: true },
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    };
    const md = renderMarkdown(treeWithVanish);
    expect(md).not.toContain('Hidden paragraph.');
    expect(md).not.toContain('A.');
  });
  // Regression (#122): notes/continuations/vanish siblings must NOT consume a CSI
  // number. A "Related Sections" pr1 whose first children are specifier-note banners
  // rendered its 1..n list starting at the note count (e.g. "5." instead of "1.").
  it('numbers pr2 siblings from 1, skipping leading note siblings', () => {
    const tree: SpecTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '09 05 00',
      title: 'Numbering',
      parts: [
        {
          id: '00000000-0000-0000-0000-000000000002',
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: '00000000-0000-0000-0000-000000000003',
              type: 'article',
              text: 'SUMMARY',
              meta: {},
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000004',
                  type: 'pr1',
                  text: 'Related Sections:',
                  meta: {},
                  children: [
                    {
                      id: 'n1',
                      type: 'note',
                      text: 'banner one',
                      children: [],
                      meta: { vanish: true },
                    },
                    {
                      id: 'n2',
                      type: 'note',
                      text: 'banner two',
                      children: [],
                      meta: { vanish: true },
                    },
                    { id: 'r1', type: 'pr2', text: 'Section 01 30 00', children: [], meta: {} },
                    { id: 'r2', type: 'pr2', text: 'Section 01 33 00', children: [], meta: {} },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = renderMarkdown(tree);
    expect(md).toContain('   1. Section 01 30 00');
    expect(md).toContain('   2. Section 01 33 00');
    expect(md).not.toContain('3. Section 01 30 00');
  });
  it('renders empty tree without error', () => {
    const empty: SpecTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '00 00 00',
      title: 'Empty',
      parts: [],
    };
    expect(renderMarkdown(empty)).toBe('# SECTION 00 00 00 — Empty');
  });
  it('renderMarkdown: suffixed section renders verbatim in H1', () => {
    const suffixed: SpecTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '27 05 13.43',
      title: 'TV Distribution',
      parts: [],
    };
    expect(renderMarkdown(suffixed)).toBe('# SECTION 27 05 13.43 — TV Distribution');
  });
  it('renders continuation without label', () => {
    const withCont: SpecTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '27 21 00',
      title: 'Test',
      parts: [
        {
          id: '00000000-0000-0000-0000-000000000002',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '00000000-0000-0000-0000-000000000003',
              type: 'article',
              text: 'SCOPE',
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000007',
                  type: 'continuation',
                  text: 'See applicable standards.',
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    };
    const md = renderMarkdown(withCont);
    expect(md).toContain('See applicable standards.');
    expect(md).not.toContain('A. See applicable standards.');
  });
});
