import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { generateSec } from './index.js';
import { parseSec } from '../../parser/index.js';
import type { SpecNode, SpecTree } from '../../ast/types.js';

// UUIDs are regenerated on every parse and `source` is always 'ufgs' here, so a
// faithful round-trip is asserted on the structural shape: section, title, and
// the (type, text, vanish) of every node in document order.
interface Shape {
  readonly type: string;
  readonly text: string;
  readonly vanish: boolean;
  readonly children: readonly Shape[];
}

function shapeOf(node: SpecNode): Shape {
  return {
    type: node.type,
    text: node.text,
    vanish: node.meta.vanish === true,
    children: node.children.map(shapeOf),
  };
}

function treeShape(tree: SpecTree): {
  section: string;
  title: string;
  parts: readonly Shape[];
} {
  return { section: tree.section, title: tree.title, parts: tree.parts.map(shapeOf) };
}

function roundTrip(xml: string): { before: SpecTree; after: SpecTree } {
  const before = parseSec(xml).tree;
  const regenerated = generateSec(before);
  const after = parseSec(regenerated).tree;
  return { before, after };
}

const WITH_PARTS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 10 00</SCN>
  <STL>BUILDING TELECOMMUNICATIONS CABLING SYSTEM</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
    <SPT>
      <TTL>DEFINITIONS</TTL>
      <TXT>A distributor from which the backbone cabling emanates.</TXT>
      <LST>For Army, the Network Enterprise Center (NEC)</LST>
      <LST>For Navy, the Base Communications Officer (BCO)</LST>
      <ITM>Sub-item text here</ITM>
    </SPT>
  </PRT>
  <PRT>
    <TTL>PART 2   PRODUCTS</TTL>
    <SPT>
      <TTL>COMPONENTS</TTL>
      <TXT>Component description here.</TXT>
    </SPT>
  </PRT>
</SEC>`;

describe('generateSec — synthetic round-trip', () => {
  it('round-trips section and title', () => {
    const { before, after } = roundTrip(WITH_PARTS);
    expect(after.section).toBe(before.section);
    expect(after.title).toBe(before.title);
  });

  it('round-trips the full part/article/list/item structure', () => {
    const { before, after } = roundTrip(WITH_PARTS);
    expect(treeShape(after)).toEqual(treeShape(before));
  });

  it('emits a parseable XML declaration and SEC root', () => {
    const xml = generateSec(parseSec(WITH_PARTS).tree);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<SEC>');
    expect(xml).toContain('</SEC>');
  });
});

describe('generateSec — entity and note round-trip', () => {
  const WITH_ENTITIES = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 01 78 23</SCN>
  <STL>OPERATION &amp; MAINTENANCE DATA</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>O&amp;M MANUAL CONTENT</TTL>
      <NTE><NPR>NOTE: O&amp;M data goes to the Contracting Officer.</NPR></NTE>
      <TXT>Clearance &lt; 600 mm &gt; 300 mm.</TXT>
    </SPT>
  </PRT>
</SEC>`;

  it('round-trips XML entities in title, article and text', () => {
    const { before, after } = roundTrip(WITH_ENTITIES);
    expect(treeShape(after)).toEqual(treeShape(before));
    expect(after.title).toBe('OPERATION & MAINTENANCE DATA');
  });

  it('round-trips notes as vanish nodes', () => {
    const { after } = roundTrip(WITH_ENTITIES);
    const note = after.parts[0]?.children[0]?.children.find((c) => c.type === 'note');
    expect(note?.meta.vanish).toBe(true);
    expect(note?.text).toContain('O&M data');
  });

  // #278 (from #251): the SEC generator FILTERS owner-removal. A body paragraph
  // removed via the /removal endpoint (meta.vanish) — and its whole subtree — is
  // dropped from the SEC egress, matching the owner-facing DOCX/Markdown renders,
  // so removed content never appears in a .SEC export. This is a FILTER, not an
  // encode: SEC's `vanish` column already means "specifier note" (the parser sets
  // it for <NTE>), so an owner-removal marker distinct from that would have to be
  // invented — filtering is the AST-honoring choice (ADR-060). A `note` is never
  // filtered (SEC notes are vanish by definition and always export as <NTE>).
  it('SEC egress: owner-removal (vanish) filters a body paragraph and its subtree (#278)', () => {
    const tree: SpecTree = {
      id: 't1',
      section: '27 10 00',
      title: 'BUILDING TELECOMMUNICATIONS CABLING SYSTEM',
      parts: [
        {
          id: 'p1',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: 's1',
              type: 'article',
              text: 'SUMMARY',
              children: [
                { id: 'keep', type: 'pr1', text: 'Kept paragraph.', children: [], meta: {} },
                {
                  id: 'r1',
                  type: 'pr1',
                  text: 'Removed paragraph.',
                  meta: { vanish: true },
                  children: [
                    { id: 'r1a', type: 'pr2', text: 'Removed child.', children: [], meta: {} },
                  ],
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    };
    const xml = generateSec(tree);
    expect(xml).not.toContain('Removed paragraph.');
    expect(xml).not.toContain('Removed child.');
    expect(xml).toContain('Kept paragraph.');
    const after = parseSec(xml).tree;
    const summary = after.parts[0]?.children[0];
    expect(summary?.children.map((c) => c.text)).toEqual(['Kept paragraph.']);
  });

  it('SEC egress: a vanished article and its whole subtree are filtered; visible peers survive (#278)', () => {
    const tree: SpecTree = {
      id: 't2',
      section: '27 10 00',
      title: 'T',
      parts: [
        {
          id: 'p1',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: 'hidden',
              type: 'article',
              text: 'REMOVED ARTICLE',
              meta: { vanish: true },
              children: [
                { id: 'x', type: 'pr1', text: 'child of removed article', children: [], meta: {} },
              ],
            },
            { id: 'shown', type: 'article', text: 'KEPT ARTICLE', meta: {}, children: [] },
          ],
          meta: {},
        },
      ],
    };
    const xml = generateSec(tree);
    expect(xml).not.toContain('REMOVED ARTICLE');
    expect(xml).not.toContain('child of removed article');
    expect(xml).toContain('<TTL>KEPT ARTICLE</TTL>');
    const after = parseSec(xml).tree;
    expect(after.parts[0]?.children.map((c) => c.text)).toEqual(['KEPT ARTICLE']);
  });

  // Regression: a filtered subtree must not influence the parent's leaf-vs-SPT
  // choice. A tier-gap paragraph (article → pr2, offset 2) whose only child is
  // owner-removed is a leaf AFTER filtering, so it must emit a childless <ITM>
  // and re-parse back as pr2 — not a nested <SPT>, which re-parses one tier
  // shallower as pr1 (#278, ADR-060; Codex adversarial review).
  it('SEC egress: a tier-gap node whose only children are hidden re-parses at its own tier, not one shallower (#278)', () => {
    const tree: SpecTree = {
      id: 't3',
      section: '27 10 00',
      title: 'T',
      parts: [
        {
          id: 'p1',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: 'a1',
              type: 'article',
              text: 'SUMMARY',
              meta: {},
              children: [
                {
                  id: 'gap',
                  type: 'pr2',
                  text: 'visible tier-gap paragraph',
                  meta: {},
                  children: [
                    {
                      id: 'gone',
                      type: 'pr3',
                      text: 'Removed child.',
                      children: [],
                      meta: { vanish: true },
                    },
                  ],
                },
              ],
            },
          ],
          meta: {},
        },
      ],
    };
    const xml = generateSec(tree);
    expect(xml).not.toContain('Removed child.');
    expect(xml).toContain('<ITM>visible tier-gap paragraph</ITM>');
    const after = parseSec(xml).tree;
    const gap = after.parts[0]?.children[0]?.children[0];
    expect(gap?.type).toBe('pr2');
    expect(gap?.children).toHaveLength(0);
  });
});

describe('generateSec — standard reference round-trip', () => {
  const WITH_REF = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 27 05 13.43</SCN>
  <STL>TELEVISION DISTRIBUTION SYSTEM</STL>
  <PRT><TTL>PART 2 PRODUCTS</TTL>
    <SPT><TTL>HEADEND EQUIPMENT</TTL>
      <SPT><TTL>Headend Amplifiers</TTL>
        <REF>
          <RID>ASTM D709</RID>
          <RTL>Laminated Thermosetting Materials</RTL>
        </REF>
      </SPT>
    </SPT>
  </PRT>
</SEC>`;

  it('round-trips a standard REF anchored to its nested SPT', () => {
    const { tree, refs } = parseSec(WITH_REF);
    const xml = generateSec(tree, refs);
    const after = parseSec(xml);
    const std = after.refs.find((r) => r.targetType === 'standard');
    expect(std?.standardCode).toBe('ASTM D709');
    expect(std?.referenceText).toBe('ASTM D709 Laminated Thermosetting Materials');
  });

  it('round-trips standard refs from a real fixture by code + text', () => {
    const xml = readFileSync(join(process.cwd(), 'tests/fixtures/sec', '27_41_00.SEC'), 'latin1');
    const { tree, refs } = parseSec(xml);
    const regen = generateSec(tree, refs);
    const after = parseSec(regen);

    const key = (r: { standardCode?: string; referenceText: string }): string =>
      `${r.standardCode ?? ''}::${r.referenceText}`;
    const cmp = (a: string, b: string): number => a.localeCompare(b);
    const beforeStd = refs
      .filter((r) => r.targetType === 'standard')
      .map(key)
      .sort(cmp);
    const afterStd = after.refs
      .filter((r) => r.targetType === 'standard')
      .map(key)
      .sort(cmp);
    expect(afterStd).toEqual(beforeStd);
  });
});

describe('generateSec — known inversion ambiguity', () => {
  // KNOWN AMBIGUITY: a parser tier is a function of SEC nesting depth (a nested
  // SPT is always parent_tier+1; ITM is +2 but only as a leaf). A child node
  // that BOTH declares a tier > parent+1 AND carries children of its own has no
  // faithful single-element inverse — a nested SPT collapses the gap to +1.
  // This shape never occurs in the UFGS corpus (every tier-gap node parsed from
  // a real fixture is a childless ITM). We render it as a nested SPT, so it
  // re-parses one tier shallower than authored. Documented, not silently picked.
  it('collapses a >+1 tier gap on a child that carries children (nested SPT only goes +1)', () => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 01 00 00</SCN>
  <STL>TEST</STL>
  <PRT><TTL>PART 1 GENERAL</TTL>
    <SPT><TTL>ARTICLE</TTL>
      <ITM>leaf pr2 at offset 2</ITM>
    </SPT>
  </PRT>
</SEC>`;
    const { tree } = parseSec(xml);
    // The childless ITM (pr2 at offset 2) round-trips exactly.
    const after = parseSec(generateSec(tree)).tree;
    const article = after.parts[0]?.children[0];
    expect(article?.children[0]?.type).toBe('pr2');
    expect(article?.children[0]?.children).toHaveLength(0);
  });
});

describe('generateSec — #296 root-level renderer parity + hidden non-note suppression', () => {
  const part = (text: string): SpecNode => ({
    id: `p-${text}`,
    type: 'part',
    text,
    children: [],
    meta: {},
  });
  const root = (roots: readonly SpecNode[]): SpecTree => ({
    id: 't',
    section: '01 00 00',
    title: 'ROOTS',
    parts: roots,
  });

  it('suppresses a hidden non-note (continuation + vanish) child — no <TXT>', () => {
    const tree = root([
      {
        id: 'p',
        type: 'part',
        text: 'GENERAL',
        meta: {},
        children: [
          {
            id: 'a',
            type: 'article',
            text: 'SUMMARY',
            meta: {},
            children: [
              {
                id: 'h',
                type: 'continuation',
                text: 'HIDDEN SIGN-OFF BODY',
                children: [],
                meta: { vanish: true },
              },
              {
                id: 'c',
                type: 'continuation',
                text: 'visible continuation',
                children: [],
                meta: {},
              },
            ],
          },
        ],
      },
    ]);
    const xml = generateSec(tree);
    expect(xml).not.toContain('HIDDEN SIGN-OFF BODY');
    expect(xml).toContain('<TXT>visible continuation</TXT>');
  });

  it('suppresses a hidden non-note continuation root — no <PRT>, no <TXT>', () => {
    const xml = generateSec(
      root([
        {
          id: 'v',
          type: 'continuation',
          text: 'HIDDEN ROOT FORM',
          children: [],
          meta: { vanish: true },
        },
        part('GENERAL'),
      ])
    );
    expect(xml).not.toContain('HIDDEN ROOT FORM');
    expect(xml).toContain('<TTL>PART 1   GENERAL</TTL>');
  });

  it('suppresses a hidden structural root — no fake PART, no part-number shift', () => {
    const xml = generateSec(
      root([
        {
          id: 'hidden-part',
          type: 'part',
          text: 'HIDDEN ROOT PART',
          children: [],
          meta: { vanish: true },
        },
        part('GENERAL'),
      ])
    );
    expect(xml).not.toContain('HIDDEN ROOT PART');
    expect(xml).toContain('<TTL>PART 1   GENERAL</TTL>');
  });

  it('renders a note root as <NTE>, not a fake <PRT>', () => {
    const xml = generateSec(
      root([
        { id: 'n', type: 'note', text: 'specifier banner', children: [], meta: { vanish: true } },
        part('GENERAL'),
      ])
    );
    expect(xml).toContain('<NTE><NPR>specifier banner</NPR></NTE>');
    expect(xml).not.toContain('PART 1   specifier banner');
    expect(xml).toContain('<TTL>PART 1   GENERAL</TTL>');
  });

  it('renders a visible continuation root as <TXT>, not a fake <PRT>', () => {
    const xml = generateSec(
      root([
        { id: 'c', type: 'continuation', text: 'preamble line', children: [], meta: {} },
        part('GENERAL'),
      ])
    );
    expect(xml).toContain('<TXT>preamble line</TXT>');
    expect(xml).not.toContain('PART 1   preamble line');
    expect(xml).toContain('<TTL>PART 1   GENERAL</TTL>');
  });

  it('PART numbering counts only real part roots (note/continuation/vanish do not shift)', () => {
    const xml = generateSec(
      root([
        { id: 'n', type: 'note', text: 'banner', children: [], meta: { vanish: true } },
        { id: 'c', type: 'continuation', text: 'preamble', children: [], meta: {} },
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
    expect(xml).toContain('<TTL>PART 1   GENERAL</TTL>');
    expect(xml).toContain('<TTL>PART 2   PRODUCTS</TTL>');
    expect(xml).not.toContain('PART 3');
    expect(xml).not.toContain('hidden form');
  });

  // KNOWN LIMITATION (#296, adjacent to #278): a root-level note/visible-continuation
  // is correct SEC OUTPUT — a specifier note belongs in the export as <NTE>, and
  // visible preamble text as <TXT> — but parseSec rebuilds roots ONLY from <PRT>
  // (sec.PRT), so a generate → re-parse round-trip silently DROPS those root nodes.
  // This manifests only for DOCX-origin trees (SEC-origin trees have <PRT>-only
  // roots, so the round-trip faithfulness contract is unaffected). The correct fix
  // is parser-side (read root-level non-PRT chrome) and out of scope for this render
  // bugfix; suppressing the roots instead would LOSE a specifier note from the
  // export — strictly worse. Pinned here so the lossiness is documented, not silent.
  it('KNOWN LIMITATION (#296): root-level note/continuation are emitted but NOT re-parseable', () => {
    const tree = root([
      {
        id: 'n',
        type: 'note',
        text: 'root specifier banner',
        children: [],
        meta: { vanish: true },
      },
      { id: 'c', type: 'continuation', text: 'root preamble line', children: [], meta: {} },
      part('GENERAL'),
    ]);
    const xml = generateSec(tree);
    // Output is correct: the note exports as <NTE>, the visible continuation as <TXT>.
    expect(xml).toContain('<NTE><NPR>root specifier banner</NPR></NTE>');
    expect(xml).toContain('<TXT>root preamble line</TXT>');
    // But re-parsing keeps only the <PRT> root — the note/continuation chrome is lost.
    const reparsed = parseSec(xml).tree;
    expect(reparsed.parts).toHaveLength(1);
    expect(reparsed.parts[0]?.type).toBe('part');
    expect(reparsed.parts.some((n) => n.type === 'note' || n.type === 'continuation')).toBe(false);
  });
});

describe('generateSec — real UFGS fixture round-trip', () => {
  it.each(['27_41_00.SEC', '27_10_00.SEC', 'deep-nesting.SEC'])(
    'parse → generate → re-parse yields an identical tree for %s',
    (file) => {
      const xml = readFileSync(join(process.cwd(), 'tests/fixtures/sec', file), 'latin1');
      const { before, after } = roundTrip(xml);
      expect(treeShape(after)).toEqual(treeShape(before));
    }
  );
});
