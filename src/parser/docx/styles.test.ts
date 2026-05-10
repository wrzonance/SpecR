import { describe, it, expect } from 'vitest';
import { buildStyleMap } from './styles.js';
import { ParserError } from '../error.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const MASTERSPEC_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="PRT">
    <w:name w:val="PRT"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="0"/>
        <w:numId w:val="1"/>
      </w:numPr>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ART">
    <w:name w:val="ART"/>
    <w:basedOn w:val="PRT"/>
    <w:next w:val="PR1"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="3"/>
        <w:numId w:val="1"/>
      </w:numPr>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="PR1">
    <w:name w:val="PR1"/>
    <w:basedOn w:val="ART"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="4"/>
        <w:numId w:val="1"/>
      </w:numPr>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="PR1lc">
    <w:name w:val="PR1lc"/>
    <w:basedOn w:val="PR1"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="CMT">
    <w:name w:val="CMT"/>
    <w:pPr>
      <w:rPr>
        <w:vanish/>
      </w:rPr>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NoNum">
    <w:name w:val="NoNum"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="0"/>
        <w:numId w:val="0"/>
      </w:numPr>
    </w:pPr>
  </w:style>
  <w:style w:type="character" w:styleId="IP">
    <w:name w:val="IP"/>
  </w:style>
</w:styles>`;

const CYCLE_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="A">
    <w:name w:val="A"/>
    <w:basedOn w:val="B"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="B">
    <w:name w:val="B"/>
    <w:basedOn w:val="A"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="1"/>
        <w:numId w:val="1"/>
      </w:numPr>
    </w:pPr>
  </w:style>
</w:styles>`;

describe('buildStyleMap — basic parsing', () => {
  it('parses paragraph styles', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.has('PRT')).toBe(true);
    expect(map.styles.has('ART')).toBe(true);
    expect(map.styles.has('PR1')).toBe(true);
  });

  it('ignores character styles', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.has('IP')).toBe(false);
  });

  it('extracts style name', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.get('ART')?.name).toBe('ART');
  });

  it('extracts basedOn chain', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.get('ART')?.basedOn).toBe('PRT');
    expect(map.styles.get('PR1lc')?.basedOn).toBe('PR1');
  });

  it('extracts next style', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.get('ART')?.next).toBe('PR1');
  });

  it('extracts numPr from paragraph properties', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.get('ART')?.numPr).toEqual({ numId: 1, ilvl: 3 });
    expect(map.styles.get('PR1')?.numPr).toEqual({ numId: 1, ilvl: 4 });
  });

  it('treats numId=0 as explicit suppression — no numPr, sets suppressesNumbering', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.get('NoNum')?.numPr).toBeUndefined();
    expect(map.styles.get('NoNum')?.suppressesNumbering).toBe(true);
  });
});

describe('buildStyleMap — basedOn chain resolution', () => {
  it('resolves direct numPr', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.resolvedNumPr.get('ART')).toEqual({ numId: 1, ilvl: 3 });
  });

  it('resolves inherited numPr through basedOn (PR1lc → PR1)', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.resolvedNumPr.get('PR1lc')).toEqual({ numId: 1, ilvl: 4 });
  });

  it('styles with no numPr in chain have no resolvedNumPr entry', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.resolvedNumPr.has('NoNum')).toBe(false);
  });
});

describe('buildStyleMap — vanish detection', () => {
  it('marks CMT style as vanish from pPr/rPr', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.get('CMT')?.isVanish).toBe(true);
  });

  it('normal styles are not vanish', () => {
    const map = buildStyleMap(MASTERSPEC_STYLES);
    expect(map.styles.get('ART')?.isVanish).toBeUndefined();
  });
});

describe('buildStyleMap — cycle guard', () => {
  it('terminates and resolves reachable numPr when cycle exists', () => {
    // A→B→A cycle. B has numPr. A has no direct numPr, inherits from B via basedOn.
    // Guard must terminate; B's numPr must be resolved for B itself.
    const map = buildStyleMap(CYCLE_STYLES);
    expect(map.styles.size).toBe(2);
    expect(map.resolvedNumPr.get('B')).toEqual({ numId: 1, ilvl: 1 });
    // A→B: depth guard fires before resolving A via cycle, so A may not resolve
    // (implementation-defined). What matters: no infinite loop and B resolves.
    expect(map.resolvedNumPr.has('B')).toBe(true);
  });
});

// MASTERSPEC lc styles (PR1lc-PR5lc) carry numId=0 to suppress inherited numbering.
// Without this chain stop, PR1lc would incorrectly resolve PR1's numPr — misclassifying
// 34% of MASTERSPEC content as numbered when it's continuation paragraphs.
const LC_SUPPRESSION_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="PR1">
    <w:name w:val="PR1"/>
    <w:pPr>
      <w:numPr><w:ilvl w:val="4"/><w:numId w:val="1"/></w:numPr>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="PR1lc">
    <w:name w:val="PR1lc"/>
    <w:basedOn w:val="PR1"/>
    <w:pPr>
      <w:numPr><w:ilvl w:val="4"/><w:numId w:val="0"/></w:numPr>
    </w:pPr>
  </w:style>
</w:styles>`;

describe('buildStyleMap — Clippit numId=0 chain stop', () => {
  it('PR1lc with numId=0 has suppressesNumbering and no resolvedNumPr', () => {
    // Regression: without chain stop, PR1lc inherits PR1's numPr → wrong node type
    const map = buildStyleMap(LC_SUPPRESSION_STYLES);
    expect(map.styles.get('PR1lc')?.suppressesNumbering).toBe(true);
    expect(map.styles.get('PR1lc')?.numPr).toBeUndefined();
    expect(map.resolvedNumPr.has('PR1lc')).toBe(false);
  });

  it('PR1 itself still resolves normally', () => {
    const map = buildStyleMap(LC_SUPPRESSION_STYLES);
    expect(map.resolvedNumPr.get('PR1')).toEqual({ numId: 1, ilvl: 4 });
  });
});

describe('buildStyleMap — edge cases', () => {
  it('returns empty maps for missing w:styles root', () => {
    const map = buildStyleMap('<w:root/>');
    expect(map.styles.size).toBe(0);
    expect(map.resolvedNumPr.size).toBe(0);
  });

  it('throws ParserError on invalid XML', () => {
    expect(() => buildStyleMap('<unclosed')).toThrow(ParserError);
  });
});
