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
  // CodeRabbit review: guard the PART ordinal threading end-to-end — an article under
  // PART 2 must render as "2.x", never fall back to "1.x". renderPart passes its own
  // index+1 as partNumber into renderArticle → getLabel('article', ordinal, partNumber).
  it('labels articles by their PART number — PART 2 article is 2.1, not 1.1', () => {
    const twoParts: SpecTree = {
      id: '00000000-0000-0000-0000-0000000000a0',
      section: '27 21 00',
      title: 'Two Parts',
      parts: [
        {
          id: '00000000-0000-0000-0000-0000000000a1',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '00000000-0000-0000-0000-0000000000a2',
              type: 'article',
              text: 'SUMMARY',
              children: [],
              meta: {},
            },
          ],
          meta: {},
        },
        {
          id: '00000000-0000-0000-0000-0000000000a3',
          type: 'part',
          text: 'PRODUCTS',
          children: [
            {
              id: '00000000-0000-0000-0000-0000000000a4',
              type: 'article',
              text: 'MANUFACTURERS',
              children: [],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    };
    const md = renderMarkdown(twoParts);
    expect(md).toContain('### 1.1 SUMMARY');
    expect(md).toContain('### 2.1 MANUFACTURERS');
    expect(md).not.toContain('### 1.1 MANUFACTURERS');
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
  // #296: root-level renderer asymmetry. renderMarkdown used to map EVERY root
  // through renderPart → "## PART {i+1}", ignoring note/vanish/continuation roots
  // that renderPrNode already honors at the child level. A hidden/note/continuation
  // root rendered as a fake PART and shifted real PART numbering by its array index.
  function rootTree(roots: SpecTree['parts']): SpecTree {
    return { id: 'r', section: '01 00 00', title: 'Roots', parts: roots };
  }
  const part = (text: string): SpecTree['parts'][number] => ({
    id: `p-${text}`,
    type: 'part',
    text,
    children: [],
    meta: {},
  });

  it('#296: suppresses a hidden (meta.vanish) non-note root — not rendered as a PART', () => {
    const md = renderMarkdown(
      rootTree([
        {
          id: 'h',
          type: 'continuation',
          text: 'SIGN-OFF FORM hidden',
          children: [],
          meta: { vanish: true },
        },
        part('GENERAL'),
      ])
    );
    expect(md).not.toContain('SIGN-OFF FORM hidden');
    expect(md).not.toContain('## PART 2');
    expect(md).toContain('## PART 1 - GENERAL');
  });

  it('#296: suppresses a hidden non-note child', () => {
    const md = renderMarkdown(
      rootTree([
        {
          id: 'p',
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: 'c',
              type: 'continuation',
              text: 'hidden child body',
              children: [],
              meta: { vanish: true },
            },
          ],
        },
      ])
    );
    expect(md).not.toContain('hidden child body');
  });

  it('#296: PART numbering counts only real part roots (note/continuation/vanish do not shift)', () => {
    const md = renderMarkdown(
      rootTree([
        { id: 'n', type: 'note', text: 'specifier banner', children: [], meta: { vanish: true } },
        { id: 'c', type: 'continuation', text: 'preamble line', children: [], meta: {} },
        {
          id: 'v',
          type: 'continuation',
          text: 'hidden form',
          children: [],
          meta: { vanish: true },
        },
        part('GENERAL'),
        part('PRODUCTS'),
      ])
    );
    expect(md).toContain('## PART 1 - GENERAL');
    expect(md).toContain('## PART 2 - PRODUCTS');
    expect(md).not.toContain('PART 3');
    // note root renders as [NOTE], continuation root as plain text, vanish suppressed
    expect(md).toContain('> **[NOTE]** specifier banner');
    expect(md).toContain('preamble line');
    expect(md).not.toContain('## PART 1 - specifier banner');
    expect(md).not.toContain('hidden form');
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
  // #300, ADR-072: object/objectText rendering. A captured body object (table
  // or text box) must never collapse to nothing — the boundary invariant
  // every case below pins first, before checking exact shape.
  function objectTextNode(id: string, text: string): SpecTree['parts'][number] {
    return { id, type: 'objectText', text, children: [], meta: {} };
  }
  function tableObjectNode(
    id: string,
    dims: { rows?: number; columns?: number },
    cells: readonly string[]
  ): SpecTree['parts'][number] {
    return {
      id,
      type: 'object',
      text: 'Table',
      children: cells.map((text, i) => objectTextNode(`${id}-c${i}`, text)),
      meta: {
        object: {
          kind: 'table',
          floating: false,
          generation: 'drawingml',
          ...dims,
          blob: [{ 'w:tbl': [] }],
        },
      },
    };
  }
  function textBoxObjectNode(
    id: string,
    floating: boolean,
    texts: readonly string[]
  ): SpecTree['parts'][number] {
    return {
      id,
      type: 'object',
      text: 'Text Box',
      children: texts.map((text, i) => objectTextNode(`${id}-c${i}`, text)),
      meta: {
        object: { kind: 'textBox', floating, generation: 'drawingml', blob: [{ 'w:p': [] }] },
      },
    };
  }

  it('#300: never renders an object node as empty markdown (non-emptiness boundary)', () => {
    const table = renderMarkdown(
      rootTree([tableObjectNode('t', { rows: 2, columns: 2 }, ['Item', 'Qty', 'Bolt', '12'])])
    );
    const mismatched = renderMarkdown(
      rootTree([tableObjectNode('t2', { rows: 2, columns: 2 }, ['Item', 'Qty', 'Bolt'])])
    );
    const textBox = renderMarkdown(rootTree([textBoxObjectNode('b', false, ['Callout text.'])]));
    for (const md of [table, mismatched, textBox]) {
      expect(md).not.toBe('');
      expect(md.trim().length).toBeGreaterThan(0);
    }
  });

  it('#300: renders a simple table grid (cell count === rows*columns) as a GFM pipe table', () => {
    const md = renderMarkdown(
      rootTree([tableObjectNode('t', { rows: 2, columns: 2 }, ['Item', 'Qty', 'Bolt', '12'])])
    );
    expect(md).toBe(
      '# SECTION 01 00 00 — Roots\n' + '\n| Item | Qty |\n| --- | --- |\n| Bolt | 12 |'
    );
  });

  it('#300: falls back to a labeled blockquote when cell count does not match rows*columns (merge/blank-cell evidence)', () => {
    const md = renderMarkdown(
      rootTree([tableObjectNode('t2', { rows: 2, columns: 2 }, ['Item', 'Qty', 'Bolt'])])
    );
    expect(md).toBe('# SECTION 01 00 00 — Roots\n' + '\n> **[TABLE]**\n   Item\n   Qty\n   Bolt');
  });

  it('#300: renders a text box as a labeled blockquote, joining interior paragraph text', () => {
    const md = renderMarkdown(
      rootTree([textBoxObjectNode('b', false, ['Line one.', 'Line two.'])])
    );
    expect(md).toBe('# SECTION 01 00 00 — Roots\n' + '\n> **[TEXT BOX]** Line one. Line two.');
  });

  it('#300: appends a floating note for a floating text box', () => {
    const md = renderMarkdown(rootTree([textBoxObjectNode('b', true, ['Callout.'])]));
    expect(md).toContain('> **[TEXT BOX]** Callout. *(floating)*');
  });

  it('#300: escapes pipes and collapses newlines in table cell text', () => {
    const md = renderMarkdown(
      rootTree([tableObjectNode('t3', { rows: 2, columns: 1 }, ['A | B', 'Line1\nLine2'])])
    );
    expect(md).toBe('# SECTION 01 00 00 — Roots\n' + '\n| A \\| B |\n| --- |\n| Line1 Line2 |');
  });

  it('#300: collapses hard breaks in text-box and fallback content so no line escapes the blockquote', () => {
    // A literal newline in a `> **[TEXT BOX]** ...` line would orphan the tail as a
    // plain paragraph outside the blockquote — same hazard escapeTableCell already
    // handles for the GFM pipe path (see the test above).
    const textBox = renderMarkdown(
      rootTree([textBoxObjectNode('b', false, ['Line one\nLine two'])])
    );
    expect(textBox).toBe('# SECTION 01 00 00 — Roots\n' + '\n> **[TEXT BOX]** Line one Line two');
    // Cell count (3) !== rows*columns (4) degrades to renderObjectFallback, whose
    // indented lines must likewise keep every line inside the blockquote.
    const fallback = renderMarkdown(
      rootTree([tableObjectNode('t4', { rows: 2, columns: 2 }, ['Line1\nLine2', 'B', 'C'])])
    );
    expect(fallback).toBe(
      '# SECTION 01 00 00 — Roots\n' + '\n> **[TABLE]**\n   Line1 Line2\n   B\n   C'
    );
  });

  it('#300: an objectText node rendered outside its parent object folds to empty, never leaking raw text', () => {
    const md = renderMarkdown(
      rootTree([objectTextNode('stray', 'stray leaf text'), part('GENERAL')])
    );
    expect(md).not.toContain('stray leaf text');
    expect(md).toContain('## PART 1 - GENERAL');
  });

  it('#300: a root-level object does not shift PART numbering (consumesNumber excludes object)', () => {
    const md = renderMarkdown(
      rootTree([
        tableObjectNode('t', { rows: 1, columns: 1 }, ['solo cell']),
        part('GENERAL'),
        part('PRODUCTS'),
      ])
    );
    expect(md).toContain('## PART 1 - GENERAL');
    expect(md).toContain('## PART 2 - PRODUCTS');
    expect(md).not.toContain('PART 3');
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
