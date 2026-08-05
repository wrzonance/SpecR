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

describe('buildStyleMap — alignment (w:jc) resolution (Codex PR #432)', () => {
  const JC_STYLES = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="Title" w:type="paragraph"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>
  <w:style w:styleId="Subtitle" w:type="paragraph"><w:name w:val="Subtitle"/><w:basedOn w:val="Title"/></w:style>
  <w:style w:styleId="Body" w:type="paragraph"><w:name w:val="Body"/></w:style>
</w:styles>`;

  it('resolves a direct style w:jc', () => {
    expect(buildStyleMap(JC_STYLES).resolvedJc.get('Title')).toBe('center');
  });

  it('resolves inherited w:jc through basedOn (Subtitle → Title)', () => {
    expect(buildStyleMap(JC_STYLES).resolvedJc.get('Subtitle')).toBe('center');
  });

  it('styles with no w:jc in chain have no resolvedJc entry', () => {
    expect(buildStyleMap(JC_STYLES).resolvedJc.has('Body')).toBe(false);
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
    // KNOWN AMBIGUITY: A→B cycle may leave A unresolved depending on guard traversal order.
    // What matters: no infinite loop and B resolves.
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
  it('styles: numId=0 stops inherited numbering for continuation style PR1lc', () => {
    // Regression: without chain stop, PR1lc inherits PR1's numPr → wrong node type
    const map = buildStyleMap(LC_SUPPRESSION_STYLES);
    expect(map.styles.get('PR1lc')?.suppressesNumbering).toBe(true);
    expect(map.styles.get('PR1lc')?.numPr).toBeUndefined();
    expect(map.resolvedNumPr.has('PR1lc')).toBe(false);
  });

  it('styles: suppression on PR1lc does not affect PR1 resolution', () => {
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

describe('vanish resolution', () => {
  it('marks a paragraph style vanish when its own rPr has w:vanish', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="Hidden" w:type="paragraph"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style>
    </w:styles>`;
    expect(buildStyleMap(xml).vanishStyleIds.has('Hidden')).toBe(true);
  });

  it('inherits vanish through the basedOn chain', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="Base" w:type="paragraph"><w:name w:val="Base"/><w:rPr><w:vanish/></w:rPr></w:style>
      <w:style w:styleId="Child" w:type="paragraph"><w:name w:val="Child"/><w:basedOn w:val="Base"/></w:style>
    </w:styles>`;
    expect(buildStyleMap(xml).vanishStyleIds.has('Child')).toBe(true);
  });

  it('captures character-style vanish into vanishCharStyleIds', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="HideChar" w:type="character"><w:name w:val="HideChar"/><w:rPr><w:vanish/></w:rPr></w:style>
    </w:styles>`;
    const m = buildStyleMap(xml);
    expect(m.vanishCharStyleIds.has('HideChar')).toBe(true);
    expect(m.vanishStyleIds.has('HideChar')).toBe(false);
  });

  it('inherits character-style vanish through the basedOn chain (CodeRabbit #295)', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="BaseHide" w:type="character"><w:name w:val="BaseHide"/><w:rPr><w:vanish/></w:rPr></w:style>
      <w:style w:styleId="ChildHide" w:type="character"><w:name w:val="ChildHide"/><w:basedOn w:val="BaseHide"/></w:style>
    </w:styles>`;
    const m = buildStyleMap(xml);
    expect(m.vanishCharStyleIds.has('ChildHide')).toBe(true);
    expect(m.vanishCharStyleIds.has('BaseHide')).toBe(true);
  });

  // w:vanish is an OOXML ST_OnOff toggle (ECMA-376 §17.3.2.45), not a bare marker:
  // an explicit w:val="0" on the STYLE's own rPr switches vanish OFF and must not
  // mark the style hidden. Presence-only checks ('w:vanish' in rPr) get this wrong.
  it('does not mark a character style vanish when its own w:vanish w:val is 0', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="NotHiddenChar" w:type="character"><w:name w:val="NotHiddenChar"/><w:rPr><w:vanish w:val="0"/></w:rPr></w:style>
    </w:styles>`;
    const m = buildStyleMap(xml);
    expect(m.vanishCharStyleIds.has('NotHiddenChar')).toBe(false);
  });

  it('does not mark a paragraph style vanish when its own w:vanish w:val is 0', () => {
    const xml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="NotHiddenPara" w:type="paragraph"><w:name w:val="NotHiddenPara"/><w:rPr><w:vanish w:val="0"/></w:rPr></w:style>
    </w:styles>`;
    expect(buildStyleMap(xml).vanishStyleIds.has('NotHiddenPara')).toBe(false);
  });
});
