import { describe, it, expect } from 'vitest';
import { buildNumberingMap, emptyNumberingMap, withArticleIlvl } from './numbering.js';
import { ParserError } from '../error.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const ARCAT_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:pStyle w:val="ARCATPart"/>
      <w:lvlText w:val="PART %1"/>
    </w:lvl>
    <w:lvl w:ilvl="1">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:pStyle w:val="ARCATArticle"/>
      <w:lvlText w:val="%1.%2"/>
    </w:lvl>
    <w:lvl w:ilvl="2">
      <w:start w:val="1"/>
      <w:numFmt w:val="upperLetter"/>
      <w:pStyle w:val="ARCATParagraph"/>
      <w:lvlText w:val="%3."/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="0"/>
  </w:num>
</w:numbering>`;

const MASTERSPEC_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:numFmt w:val="decimal"/>
      <w:pStyle w:val="PRT"/>
      <w:lvlText w:val="PART %1 -"/>
    </w:lvl>
    <w:lvl w:ilvl="1">
      <w:numFmt w:val="decimal"/>
      <w:pStyle w:val="SCT"/>
      <w:lvlText w:val="SCHEDULE %2 -"/>
    </w:lvl>
    <w:lvl w:ilvl="2">
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="PRODUCT DATA SHEET %3 -"/>
    </w:lvl>
    <w:lvl w:ilvl="3">
      <w:numFmt w:val="decimal"/>
      <w:pStyle w:val="ART"/>
      <w:lvlText w:val="%1.%4"/>
    </w:lvl>
    <w:lvl w:ilvl="4">
      <w:numFmt w:val="upperLetter"/>
      <w:pStyle w:val="PR1"/>
      <w:lvlText w:val="%5."/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="0"/>
  </w:num>
</w:numbering>`;

const MULTI_NUM_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:numFmt w:val="decimal"/>
      <w:pStyle w:val="PRT"/>
      <w:lvlText w:val="PART %1"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="0"/>
  </w:num>
  <w:num w:numId="2">
    <w:abstractNumId w:val="0"/>
    <w:lvlOverride w:ilvl="0">
      <w:startOverride w:val="2"/>
    </w:lvlOverride>
  </w:num>
</w:numbering>`;

describe('buildNumberingMap — ARCAT style', () => {
  it('parses abstractNum with correct level count', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.abstractNums.get(0)?.levels).toHaveLength(3);
  });

  it('extracts numFmt correctly', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.abstractNums.get(0)?.levels[0]?.numFmt).toBe('decimal');
    expect(map.abstractNums.get(0)?.levels[2]?.numFmt).toBe('upperLetter');
  });

  it('extracts pStyle links', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.abstractNums.get(0)?.levels[0]?.pStyle).toBe('ARCATPart');
    expect(map.abstractNums.get(0)?.levels[1]?.pStyle).toBe('ARCATArticle');
  });

  it('builds pStyleToNumId from pStyle links', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.pStyleToNumId.get('ARCATPart')).toBe(1);
    expect(map.pStyleToNumId.get('ARCATArticle')).toBe(1);
    expect(map.pStyleToNumId.get('ARCATParagraph')).toBe(1);
  });

  it('builds pStyleToIlvl from pStyle links', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.pStyleToIlvl.get('ARCATPart')).toBe(0);
    expect(map.pStyleToIlvl.get('ARCATArticle')).toBe(1);
    expect(map.pStyleToIlvl.get('ARCATParagraph')).toBe(2);
  });

  it('detects articleIlvl=1 for ARCAT (no Schedule/PDS reserved levels)', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.articleIlvl).toBe(1);
  });

  it('parses num with correct abstractNumId', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.nums.get(1)?.abstractNumId).toBe(0);
  });
});

describe('buildNumberingMap — MASTERSPEC style', () => {
  it('detects articleIlvl=3 from SCHEDULE/PDS lvlText in numbering.xml', () => {
    const map = buildNumberingMap(MASTERSPEC_NUMBERING);
    expect(map.articleIlvl).toBe(3);
  });

  it('withArticleIlvl overrides articleIlvl on an existing map', () => {
    const map = buildNumberingMap(MASTERSPEC_NUMBERING);
    const overridden = withArticleIlvl(map, 3);
    expect(overridden.articleIlvl).toBe(3);
    // other fields preserved
    expect(overridden.pStyleToIlvl.get('ART')).toBe(map.pStyleToIlvl.get('ART'));
  });

  it('maps ART style to ilvl 3', () => {
    const map = buildNumberingMap(MASTERSPEC_NUMBERING);
    expect(map.pStyleToIlvl.get('ART')).toBe(3);
  });

  it('maps PR1 style to ilvl 4', () => {
    const map = buildNumberingMap(MASTERSPEC_NUMBERING);
    expect(map.pStyleToIlvl.get('PR1')).toBe(4);
  });
});

describe('buildNumberingMap — multi-num', () => {
  it('parses two num instances sharing same abstractNum', () => {
    const map = buildNumberingMap(MULTI_NUM_NUMBERING);
    expect(map.nums.size).toBe(2);
    expect(map.nums.get(2)?.abstractNumId).toBe(0);
  });

  it('parses lvlOverride with startOverride', () => {
    const map = buildNumberingMap(MULTI_NUM_NUMBERING);
    const overrides = map.nums.get(2)?.lvlOverride;
    expect(overrides).toBeDefined();
    expect(overrides?.[0]?.startOverride).toBe(2);
  });
});

describe('buildNumberingMap — edge cases', () => {
  it('returns emptyNumberingMap for missing w:numbering root', () => {
    const map = buildNumberingMap('<w:root/>');
    expect(map.nums.size).toBe(0);
    expect(map.abstractNums.size).toBe(0);
    expect(map.articleIlvl).toBe(1);
  });

  it('throws ParserError on invalid XML', () => {
    expect(() => buildNumberingMap('<unclosed')).toThrow(ParserError);
  });
});

describe('emptyNumberingMap', () => {
  it('returns map with articleIlvl=1 as default', () => {
    const map = emptyNumberingMap();
    expect(map.articleIlvl).toBe(1);
    expect(map.nums.size).toBe(0);
  });
});

describe('buildNumberingMap — missing optional fields', () => {
  it('handles level with no lvlText or pStyle', () => {
    const xml = `<?xml version="1.0"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(xml);
    const lvl = map.abstractNums.get(0)?.levels[0];
    expect(lvl?.lvlText).toBeUndefined();
    expect(lvl?.pStyle).toBeUndefined();
    expect(lvl?.start).toBeUndefined();
  });

  it('uses decimal as default numFmt when w:numFmt absent', () => {
    const xml = `<?xml version="1.0"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"/>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(xml);
    expect(map.abstractNums.get(0)?.levels[0]?.numFmt).toBe('decimal');
  });
});

describe('buildNumberingMap — lvlRestart and orphan num', () => {
  it('handles level with lvlRestart', () => {
    const xml = `<?xml version="1.0"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlRestart w:val="0"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(xml);
    expect(map.abstractNums.get(0)?.levels[0]?.lvlRestart).toBe(0);
  });

  it('skips pStyleToNumId for num referencing missing abstractNum', () => {
    const xml = `<?xml version="1.0"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:pStyle w:val="PRT"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="99"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(xml);
    expect(map.pStyleToNumId.get('PRT')).toBe(1);
    expect(map.nums.size).toBe(2);
  });
});
