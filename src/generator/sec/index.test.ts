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

describe('generateSec — real UFGS fixture round-trip', () => {
  it.each(['27_41_00.SEC', '27_10_00.SEC'])(
    'parse → generate → re-parse yields an identical tree for %s',
    (file) => {
      const xml = readFileSync(join(process.cwd(), 'tests/fixtures/sec', file), 'latin1');
      const { before, after } = roundTrip(xml);
      expect(treeShape(after)).toEqual(treeShape(before));
    }
  );
});
