import { describe, it, expect } from 'vitest';
import { parseSec } from './index.js';
import { ParserError } from '../error.js';
import type { CsiNode } from '../../ast/types.js';

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

function collectIds(nodes: readonly CsiNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (ns: readonly CsiNode[]) => {
    for (const n of ns) {
      ids.add(n.id);
      walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

describe('parseSec — section and title', () => {
  it('extracts section number from SCN', () => {
    const { tree } = parseSec(MINIMAL);
    expect(tree.section).toBe('27 10 00');
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

  it('throws ParserError when SCN missing', () => {
    const bad = `<?xml version="1.0"?><SEC><STL>Title</STL></SEC>`;
    expect(() => parseSec(bad)).toThrow(ParserError);
  });

  it('throws ParserError when STL missing', () => {
    const bad = `<?xml version="1.0"?><SEC><SCN>SECTION 27 10 00</SCN></SEC>`;
    expect(() => parseSec(bad)).toThrow(ParserError);
  });
});

describe('parseSec — PRT / SPT hierarchy', () => {
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
    expect(ids.size).toBeGreaterThan(0);
  });

  it('sets source: ufgs on all node meta', () => {
    const { tree } = parseSec(WITH_PARTS);
    expect(tree.parts[0]?.meta.source).toBe('ufgs');
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
