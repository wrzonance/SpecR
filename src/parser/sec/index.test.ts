import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseSec } from './index.js';
import { ParserError } from '../error.js';
import type { SpecNode } from '../../ast/types.js';

const MINIMAL = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <MTA NAME="AUTONUMBER" CONTENT="TRUE"/>
  <SCN>SECTION 27 10 00</SCN>
  <STL>BUILDING TELECOMMUNICATIONS CABLING SYSTEM</STL>
</SEC>`;

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

const WITH_NOTES = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <NTE>
        <NPR>NOTE: This paragraph lists publications cited in the text.</NPR>
        <NPR>Use the Reference Wizard to check references.</NPR>
      </NTE>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
  </PRT>
</SEC>`;

const WITH_MIXED_CONTENT = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>RELATED REQUIREMENTS</TTL>
      <TXT>Section <SRF>26 20 00</SRF> INTERIOR DISTRIBUTION SYSTEM applies.</TXT>
      <LST>See <SRF>27 05 13.43</SRF> TELEVISION DISTRIBUTION SYSTEM for CATV.</LST>
    </SPT>
  </PRT>
</SEC>`;

function collectIds(nodes: readonly SpecNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (ns: readonly SpecNode[]) => {
    for (const n of ns) {
      ids.add(n.id);
      walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

function countNodes(nodes: readonly SpecNode[]): number {
  let total = 0;
  for (const n of nodes) {
    total++;
    total += countNodes(n.children);
  }
  return total;
}

function childNamed(parent: SpecNode | undefined, text: string): SpecNode | undefined {
  if (parent === undefined) return undefined;
  return parent.children.find((child) => child.text === text);
}

function flattenTypes(nodes: readonly SpecNode[]): string[] {
  return nodes.flatMap((node) => [node.type, ...flattenTypes(node.children)]);
}

describe('parseSec — section and title', () => {
  it('extracts section number from SCN', () => {
    const { tree } = parseSec(MINIMAL);
    expect(tree.section).toBe('27 10 00');
  });

  it.each([
    ['SECTION 099100', '09 91 00'],
    ['SECTION 09.91.00', '09 91 00'],
    ['SECTION 09 9100', '09 91 00'],
    ['SECTION 013201.00 10', '01 32 01.00 10'],
    ['SECTION 01.32.01.00 10', '01 32 01.00 10'],
  ])('normalizes SCN display variant %s before AST validation', (scn, expected) => {
    const xml = `<?xml version="1.0"?><SEC><SCN>${scn}</SCN><STL>TEST</STL></SEC>`;
    const { tree } = parseSec(xml);
    expect(tree.section).toBe(expected);
  });

  it('extracts title from STL', () => {
    const { tree } = parseSec(MINIMAL);
    expect(tree.title).toBe('BUILDING TELECOMMUNICATIONS CABLING SYSTEM');
  });

  it('assigns UUID to tree id', () => {
    const { tree } = parseSec(MINIMAL);
    expect(tree.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('returns empty parts when no PRT elements', () => {
    const { tree } = parseSec(MINIMAL);
    expect(tree.parts).toHaveLength(0);
  });

  it('regression: missing SCN yields unknown section for inference recovery', () => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <STL>Fallback Title</STL>
  <PRT>
    <TTL>PART 1 GENERAL</TTL>
    <SPT><TTL>SECTION 26 09 33</TTL></SPT>
  </PRT>
</SEC>`;
    const { tree } = parseSec(xml);
    expect(tree.section).toBe('unknown');
    expect(tree.title).toBe('Fallback Title');
  });

  it('regression: 11_72_13.SEC reads SCN/STL from HL3 heading wrapper', () => {
    const xml = readFileSync(
      resolve(process.cwd(), 'docs/references/UFGS/DIVISION_11/11_72_13.SEC'),
      'latin1'
    );
    const { tree } = parseSec(xml);
    expect(tree.section).toBe('11 72 13');
    expect(tree.title).toBe('MEDICAL EQUIPMENT, MISCELLANEOUS');
  });

  it('throws ParserError when STL missing', () => {
    const bad = `<?xml version="1.0"?><SEC><SCN>SECTION 27 10 00</SCN></SEC>`;
    expect(() => parseSec(bad)).toThrow(ParserError);
  });
});

describe('parseSec — PRT structure', () => {
  it('maps PRT to part nodes', () => {
    const { tree } = parseSec(WITH_PARTS);
    expect(tree.parts).toHaveLength(2);
    expect(tree.parts[0]?.type).toBe('part');
  });
  it('strips PART N prefix from part title', () => {
    const { tree } = parseSec(WITH_PARTS);
    expect(tree.parts[0]?.text).toBe('GENERAL');
    expect(tree.parts[1]?.text).toBe('PRODUCTS');
  });
  it('maps SPT to article nodes as part children', () => {
    const { tree } = parseSec(WITH_PARTS);
    expect(tree.parts[0]?.children).toHaveLength(2);
    expect(tree.parts[0]?.children[0]?.type).toBe('article');
  });
  it('sets article text from TTL', () => {
    const { tree } = parseSec(WITH_PARTS);
    expect(tree.parts[0]?.children[0]?.text).toBe('REFERENCES');
  });
  it('sets source: ufgs on all node meta', () => {
    const { tree } = parseSec(WITH_PARTS);
    expect(tree.parts[0]?.meta.source).toBe('ufgs');
  });
});

describe('parseSec — non-conforming part numbering (#316)', () => {
  const DECIMAL_PART = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 10 00</SCN>
  <STL>BUILDING TELECOMMUNICATIONS CABLING SYSTEM</STL>
  <PRT>
    <TTL>PART 1.1 GENERAL</TTL>
    <SPT><TTL>REFERENCES</TTL><TXT>Publications.</TXT></SPT>
  </PRT>
</SEC>`;

  it('warns: PART 1.1 decimal part heading is non-conforming — one warning, structure intact', () => {
    const { tree } = parseSec(DECIMAL_PART);
    const nonConforming =
      tree.warnings?.filter((w) => w.type === 'non-conforming-part-numbering') ?? [];
    expect(nonConforming).toHaveLength(1);
    expect(nonConforming[0]?.lineHint).toBe('PART 1.1 GENERAL');
    // The decimal number is deliberately left in the title (stripPartPrefix, #297).
    expect(tree.parts).toHaveLength(1);
    expect(tree.parts[0]?.type).toBe('part');
  });

  it('conforming UFGS parts (number is structural, not in TTL) → no warnings field', () => {
    const { tree } = parseSec(WITH_PARTS);
    expect(tree.warnings).toBeUndefined();
  });
});

describe('parseSec — SPT content nodes', () => {
  it('maps TXT to continuation nodes', () => {
    const { tree } = parseSec(WITH_PARTS);
    const article = tree.parts[0]?.children[0];
    expect(article?.children[0]?.type).toBe('continuation');
    expect(article?.children[0]?.text).toContain('publications listed below');
  });
  it('maps LST to pr1 nodes', () => {
    const { tree } = parseSec(WITH_PARTS);
    const defs = tree.parts[0]?.children[1];
    const pr1s = defs?.children.filter((c) => c.type === 'pr1') ?? [];
    expect(pr1s).toHaveLength(2);
    expect(pr1s[0]?.text).toBe('For Army, the Network Enterprise Center (NEC)');
  });
  it('maps ITM to pr2 nodes', () => {
    const { tree } = parseSec(WITH_PARTS);
    const defs = tree.parts[0]?.children[1];
    const pr2 = defs?.children.find((c) => c.type === 'pr2');
    expect(pr2?.text).toBe('Sub-item text here');
  });
  it('assigns unique UUID to every node', () => {
    const { tree } = parseSec(WITH_PARTS);
    const ids = collectIds(tree.parts);
    const total = countNodes(tree.parts);
    expect(ids.size).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it('regression: nested SPT under article — 27 05 13.43 Headend Amplifiers is pr1, not article', () => {
    const xml = readFileSync(
      resolve(process.cwd(), 'docs/references/UFGS/DIVISION_27/27_05_13.43.SEC'),
      'latin1'
    );
    const { tree } = parseSec(xml);
    const products = tree.parts.find((p) => p.text === 'PRODUCTS');
    const headend = products?.children.find((c) => c.text === 'HEADEND EQUIPMENT');
    const amplifiers = headend?.children.find((c) => c.text === 'Headend Amplifiers');

    expect(headend?.type).toBe('article');
    expect(amplifiers?.type).toBe('pr1');
  });

  it('maps nested SPT depth to CSI paragraph tiers', () => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 27 05 13.43</SCN>
  <STL>TELEVISION DISTRIBUTION SYSTEM</STL>
  <PRT><TTL>PART 2 PRODUCTS</TTL>
    <SPT><TTL>HEADEND EQUIPMENT</TTL>
      <SPT><TTL>Headend Amplifiers</TTL>
        <LST>Amplifier chassis</LST>
        <ITM>Gain control</ITM>
        <OLG><OLI>Factory test report</OLI></OLG>
        <SPT><TTL>Gain Controls</TTL></SPT>
      </SPT>
    </SPT>
  </PRT>
</SEC>`;
    const { tree } = parseSec(xml);
    const article = tree.parts[0]?.children[0];
    const pr1 = childNamed(article, 'Headend Amplifiers');
    const pr2 = childNamed(pr1, 'Gain Controls');
    const lst = childNamed(pr1, 'Amplifier chassis');
    const itm = childNamed(pr1, 'Gain control');
    const oli = childNamed(pr1, 'Factory test report');

    expect(article?.type).toBe('article');
    expect(pr1?.type).toBe('pr1');
    expect(pr2?.type).toBe('pr2');
    expect(lst?.type).toBe('pr2');
    expect(itm?.type).toBe('pr3');
    expect(oli?.type).toBe('pr2');
  });

  it('maps deep SEC list items to pr6 before the pr7 cap', () => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 01 57 19</SCN>
  <STL>TEMPORARY ENVIRONMENTAL CONTROLS</STL>
  <PRT><TTL>PART 1 GENERAL</TTL>
    <SPT><TTL>Article</TTL>
      <SPT><TTL>Tier 1</TTL>
        <SPT><TTL>Tier 2</TTL>
          <SPT><TTL>Tier 3</TTL>
            <SPT><TTL>Tier 4</TTL>
              <SPT><TTL>Tier 5</TTL>
                <OLG><OLI>Tier 6 ordered item</OLI></OLG>
              </SPT>
            </SPT>
          </SPT>
        </SPT>
      </SPT>
    </SPT>
  </PRT>
</SEC>`;
    const { tree } = parseSec(xml);
    const article = tree.parts[0]?.children[0];
    const pr1 = childNamed(article, 'Tier 1');
    const pr2 = childNamed(pr1, 'Tier 2');
    const pr3 = childNamed(pr2, 'Tier 3');
    const pr4 = childNamed(pr3, 'Tier 4');
    const pr5 = childNamed(pr4, 'Tier 5');
    const pr6 = childNamed(pr5, 'Tier 6 ordered item');

    expect(pr5?.type).toBe('pr5');
    expect(pr6?.type).toBe('pr6');
  });

  // KNOWN AMBIGUITY: .SEC imposes no nesting cap, but the AST / Word numbering
  // model stops at pr7. SPT depths >= 7 all saturate to pr7 (sptNodeType default
  // branch), so distinct source depths collapse to a single type and the original
  // depth is not recoverable on round-trip. ADR-027 records this as deliberately
  // lossy until a future inference-conflict workflow handles deeper tiers.
  it('KNOWN AMBIGUITY: SEC SPT depths beyond pr7 saturate to pr7 (lossy)', () => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 01 57 19</SCN>
  <STL>TEMPORARY ENVIRONMENTAL CONTROLS</STL>
  <PRT><TTL>PART 1 GENERAL</TTL>
    <SPT><TTL>Article</TTL>
      <SPT><TTL>Tier 1</TTL>
        <SPT><TTL>Tier 2</TTL>
          <SPT><TTL>Tier 3</TTL>
            <SPT><TTL>Tier 4</TTL>
              <SPT><TTL>Tier 5</TTL>
                <SPT><TTL>Tier 6</TTL>
                  <SPT><TTL>Tier 7</TTL>
                    <SPT><TTL>Tier 8</TTL>
                      <SPT><TTL>Tier 9</TTL></SPT>
                    </SPT>
                  </SPT>
                </SPT>
              </SPT>
            </SPT>
          </SPT>
        </SPT>
      </SPT>
    </SPT>
  </PRT>
</SEC>`;
    const { tree } = parseSec(xml);
    const article = tree.parts[0]?.children[0];
    const pr1 = childNamed(article, 'Tier 1');
    const pr2 = childNamed(pr1, 'Tier 2');
    const pr3 = childNamed(pr2, 'Tier 3');
    const pr4 = childNamed(pr3, 'Tier 4');
    const pr5 = childNamed(pr4, 'Tier 5');
    const pr6 = childNamed(pr5, 'Tier 6');
    const depth7 = childNamed(pr6, 'Tier 7');
    const depth8 = childNamed(depth7, 'Tier 8');
    const depth9 = childNamed(depth8, 'Tier 9');

    expect(pr6?.type).toBe('pr6');
    // depth 7 is the last distinct tier; 8 and 9 collapse onto it (lossy)
    expect(depth7?.type).toBe('pr7');
    expect(depth8?.type).toBe('pr7');
    expect(depth9?.type).toBe('pr7');
  });

  it('regression: deep valid SEC fixture contains pr6 environmental-control items', () => {
    const xml = readFileSync(
      resolve(process.cwd(), 'tests/fixtures/sec/deep-nesting.SEC'),
      'latin1'
    );
    const { tree } = parseSec(xml);
    const allTypes = flattenTypes(tree.parts);

    expect(allTypes).toContain('pr6');
  });

  it('regression: nested standard ref keeps the nested SPT as source node', () => {
    const xml = `<?xml version="1.0"?>
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
    const { tree, refs } = parseSec(xml);
    const article = tree.parts[0]?.children[0];
    const pr1 = childNamed(article, 'Headend Amplifiers');
    const standardRef = refs.find((r) => r.targetType === 'standard');

    expect(pr1?.type).toBe('pr1');
    expect(standardRef?.sourceNodeId).toBe(pr1?.id);
  });
});

describe('parseSec — NTE / NPR notes', () => {
  it('maps NPR inside NTE to note nodes with vanish: true', () => {
    const { tree } = parseSec(WITH_NOTES);
    const article = tree.parts[0]?.children[0];
    const notes = article?.children.filter((c) => c.type === 'note') ?? [];
    expect(notes).toHaveLength(2);
    expect(notes[0]?.meta.vanish).toBe(true);
  });

  it('sets note text from NPR content', () => {
    const { tree } = parseSec(WITH_NOTES);
    const note = tree.parts[0]?.children[0]?.children.find((c) => c.type === 'note');
    expect(note?.text).toContain('This paragraph lists publications');
  });
});

describe('parseSec — text extraction from mixed content', () => {
  it('strips XML tags from TXT, keeps text', () => {
    const { tree } = parseSec(WITH_MIXED_CONTENT);
    const txt = tree.parts[0]?.children[0]?.children.find((c) => c.type === 'continuation');
    expect(txt?.text).toContain('INTERIOR DISTRIBUTION SYSTEM');
    expect(txt?.text).not.toContain('<SRF>');
  });

  it('strips XML tags from LST, keeps text', () => {
    const { tree } = parseSec(WITH_MIXED_CONTENT);
    const pr1 = tree.parts[0]?.children[0]?.children.find((c) => c.type === 'pr1');
    expect(pr1?.text).toContain('TELEVISION DISTRIBUTION SYSTEM');
    expect(pr1?.text).not.toContain('<SRF>');
  });
});

describe('parseSec — SRF normalization', () => {
  it.each([
    ['099100', '09 91 00'],
    ['09.91.00', '09 91 00'],
    ['01.32.01.00 10', '01 32 01.00 10'],
  ])('normalizes SRF display variant %s before ref resolution', (srf, expected) => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT><TTL>PART 1 GENERAL</TTL><SPT><TTL>RELATED</TTL>
    <TXT>Section <SRF>${srf}</SRF> applies.</TXT>
  </SPT></PRT>
</SEC>`;
    const { refs } = parseSec(xml);
    expect(refs.find((r) => r.targetType === 'section')?.targetSpecSection).toBe(expected);
  });
});

describe('parseSec — XML entity decoding', () => {
  const WITH_ENTITIES = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 01 78 23</SCN>
  <STL>OPERATION &amp; MAINTENANCE DATA</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>O&amp;M MANUAL CONTENT</TTL>
      <TXT>Submit data per Section <SRF>01 33 00</SRF> &amp; the contract clauses.</TXT>
      <LST>Temperature range 10&#176;C to 40&#176;C (&quot;operating&quot;)</LST>
      <ITM>Clearance &lt; 600 mm &gt; 300 mm; use O&apos;Brien&#x2019;s fittings</ITM>
      <NTE>
        <NPR>NOTE: O&amp;M data goes to the Contracting Officer.</NPR>
      </NTE>
      <REF>
        <RID>ASTM D709</RID>
        <RTL>Laminated Thermosetting Materials &amp; Components</RTL>
      </REF>
    </SPT>
  </PRT>
</SEC>`;

  it('regression: O&amp;M in article TTL decodes to O&M, not double-escaped (01 78 23 part 1.6)', () => {
    const { tree } = parseSec(WITH_ENTITIES);
    const article = tree.parts[0]?.children.find((c) => c.type === 'article');
    expect(article?.text).toBe('O&M MANUAL CONTENT');
  });

  it('decodes &amp; in STL section title', () => {
    const { tree } = parseSec(WITH_ENTITIES);
    expect(tree.title).toBe('OPERATION & MAINTENANCE DATA');
  });

  it('decodes &amp; in TXT mixed content', () => {
    const { tree } = parseSec(WITH_ENTITIES);
    const article = tree.parts[0]?.children.find((c) => c.type === 'article');
    const txt = article?.children.find((c) => c.type === 'continuation');
    expect(txt?.text).toContain('& the contract clauses');
    expect(txt?.text).not.toContain('&amp;');
  });

  it('decodes numeric and named entities in LST (&#176; -> degree sign, &quot; -> ")', () => {
    const { tree } = parseSec(WITH_ENTITIES);
    const article = tree.parts[0]?.children.find((c) => c.type === 'article');
    const lst = article?.children.find((c) => c.type === 'pr1');
    expect(lst?.text).toBe('Temperature range 10°C to 40°C ("operating")');
  });

  it('decodes &lt; &gt; &apos; and hex references in ITM', () => {
    const { tree } = parseSec(WITH_ENTITIES);
    const article = tree.parts[0]?.children.find((c) => c.type === 'article');
    const itm = article?.children.find((c) => c.type === 'pr2');
    expect(itm?.text).toBe("Clearance < 600 mm > 300 mm; use O'Brien’s fittings");
  });

  it('decodes entities in note NPR text', () => {
    const { tree } = parseSec(WITH_ENTITIES);
    const article = tree.parts[0]?.children.find((c) => c.type === 'article');
    const note = article?.children.find((c) => c.type === 'note');
    expect(note?.text).toContain('O&M data');
  });

  it('decodes entities in standard-ref referenceText (RTL)', () => {
    const { refs } = parseSec(WITH_ENTITIES);
    const std = refs.find((r) => r.targetType === 'standard');
    expect(std?.referenceText).toBe('ASTM D709 Laminated Thermosetting Materials & Components');
  });

  it('decodes entities in section-ref referenceText', () => {
    const { refs } = parseSec(WITH_ENTITIES);
    const sec = refs.find((r) => r.targetType === 'section');
    expect(sec?.referenceText).toContain('& the contract clauses');
  });

  it('double-escaped &amp;amp; decodes exactly once (to literal &amp;)', () => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 01 00 00</SCN>
  <STL>TEST</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>ESCAPING</TTL>
      <TXT>literal entity: &amp;amp; stays escaped once</TXT>
    </SPT>
  </PRT>
</SEC>`;
    const { tree } = parseSec(xml);
    const article = tree.parts[0]?.children.find((c) => c.type === 'article');
    const txt = article?.children.find((c) => c.type === 'continuation');
    expect(txt?.text).toContain('literal entity: &amp; stays escaped once');
  });

  it('leaves out-of-range numeric references untouched instead of throwing', () => {
    const xml = `<?xml version="1.0"?>
<SEC>
  <SCN>SECTION 01 00 00</SCN>
  <STL>TEST</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>BOUNDS</TTL>
      <TXT>bogus reference &#x110000; survives</TXT>
    </SPT>
  </PRT>
</SEC>`;
    const { tree } = parseSec(xml);
    const article = tree.parts[0]?.children.find((c) => c.type === 'article');
    const txt = article?.children.find((c) => c.type === 'continuation');
    expect(txt?.text).toContain('bogus reference &#x110000; survives');
  });
});

describe('parseSec — SCN/SRF whitespace canonicalization', () => {
  it('sec parser: SCN with whitespace dirt normalizes to canonical form', () => {
    const xml = `<?xml version="1.0"?><SEC><SCN>SECTION  26 00 13.10 </SCN><STL>PANELBOARDS</STL></SEC>`;
    const { tree } = parseSec(xml);
    expect(tree.section).toBe('26 00 13.10');
  });

  it('sec parser: SCN with internal whitespace dirt normalizes (prefix-strip alone cannot fix)', () => {
    const xml = `<?xml version="1.0"?><SEC><SCN>SECTION 26  00 13.10</SCN><STL>PANELBOARDS</STL></SEC>`;
    const { tree } = parseSec(xml);
    expect(tree.section).toBe('26 00 13.10');
  });

  it('regression: SCN decodes entity whitespace before stripping SECTION prefix', () => {
    const xml = `<?xml version="1.0"?><SEC><SCN>SECTION&#160;26 09 33</SCN><STL>MOTOR CONTROLLERS</STL></SEC>`;
    const { tree } = parseSec(xml);
    expect(tree.section).toBe('26 09 33');
  });

  it('sec parser: SRF target normalizes NBSP separators to canonical form', () => {
    // NBSP (U+00A0) separators -- written as escape sequences to avoid no-irregular-whitespace
    const nbsp = '\u00a0';
    const srfContent = `26${nbsp}00${nbsp}13.10`;
    const xml =
      `<?xml version="1.0"?><SEC><SCN>SECTION 27 41 00</SCN><STL>T</STL>` +
      `<PRT><TTL>PART 1</TTL><SPT><TTL>X</TTL><TXT>See <SRF>${srfContent}</SRF> now.</TXT></SPT></PRT></SEC>`;
    const { refs } = parseSec(xml);
    const sRef = refs.find((r) => r.targetType === 'section');
    expect(sRef?.targetSpecSection).toBe('26 00 13.10');
  });

  it('sec parser: unnormalizable SRF content kept verbatim (never dropped)', () => {
    const xml = `<?xml version="1.0"?><SEC><SCN>SECTION 27 41 00</SCN><STL>T</STL><PRT><TTL>PART 1</TTL><SPT><TTL>X</TTL><TXT>See <SRF>APPENDIX B</SRF> now.</TXT></SPT></PRT></SEC>`;
    const { refs } = parseSec(xml);
    const sRef = refs.find((r) => r.targetType === 'section');
    expect(sRef?.targetSpecSection).toBe('APPENDIX B');
  });
});
