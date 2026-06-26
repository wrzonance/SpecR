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

// Generic single-level list: one pStyle link, NON-PART lvlText. Deliberately
// not "PART %1" so the spec-shaped test below isolates the pStyle-ladder
// threshold (a "PART" lvlText is a separate, intentional spec-shaped signal).
const MULTI_NUM_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:numFmt w:val="decimal"/>
      <w:pStyle w:val="PRT"/>
      <w:lvlText w:val="%1."/>
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
    // Start from emptyNumberingMap (articleIlvl=1) and override to 3
    const base = emptyNumberingMap();
    expect(base.articleIlvl).toBe(1);
    const overridden = withArticleIlvl(base, 3);
    expect(overridden.articleIlvl).toBe(3);
    // other fields preserved
    expect(overridden.pStyleToNumId).toBe(base.pStyleToNumId);
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

describe('buildNumberingMap — spec-shaped ladder detection', () => {
  it('regression: ARCAT ladder (3 pStyle-linked levels) marks numId 1 spec-shaped — 21 11 00 produced 34 parts', () => {
    const map = buildNumberingMap(ARCAT_NUMBERING);
    expect(map.specShapedNumIds.has(1)).toBe(true);
  });

  it('MasterFormat-style ladder (4 linked levels) is spec-shaped', () => {
    const map = buildNumberingMap(MASTERSPEC_NUMBERING);
    expect(map.specShapedNumIds.has(1)).toBe(true);
  });

  it('single-linked-level numbering is NOT spec-shaped (both numIds)', () => {
    const map = buildNumberingMap(MULTI_NUM_NUMBERING);
    expect(map.specShapedNumIds.has(1)).toBe(false);
    expect(map.specShapedNumIds.has(2)).toBe(false);
  });

  it('flat generic list with zero pStyle links is NOT spec-shaped — LibreOffice <ol> stays guarded', () => {
    const flat = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl>
    <w:lvl w:ilvl="2"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(flat);
    expect(map.specShapedNumIds.has(5)).toBe(false);
  });

  it('emptyNumberingMap has empty specShapedNumIds', () => {
    expect(emptyNumberingMap().specShapedNumIds.size).toBe(0);
  });
});

describe('buildNumberingMap — ilvl=0 lvlText declares PART (CPI non-pStyle-linked)', () => {
  const CPI_PART_LVLTEXT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="5">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="PART %1 -"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="5"/></w:num>
</w:numbering>`;

  it('CPI PART inference: ilvl=0 lvlText "PART %1 -" with 0 pStyle links marks numId spec-shaped', () => {
    const map = buildNumberingMap(CPI_PART_LVLTEXT);
    // numId 1's abstractNum links zero pStyles, but its ilvl=0 lvlText generates
    // a literal "PART n" prefix — strong evidence ilvl=0 is a real PART heading.
    expect(map.specShapedNumIds.has(1)).toBe(true);
  });

  it('generic list with ilvl=0 lvlText "%1." and 0 pStyle links is NOT spec-shaped', () => {
    const generic = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(generic);
    expect(map.specShapedNumIds.has(7)).toBe(false);
  });

  it('real ARCAT lvlText "PART  %1  " (double-spaced) with 0 pStyle links marks numId spec-shaped', () => {
    // The actual ARCAT label template uses two spaces around the field; the
    // start-anchored detector must still match it (guards against over-tightening).
    const arcat = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="3">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="PART  %1  "/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="9"><w:abstractNumId w:val="3"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(arcat);
    expect(map.specShapedNumIds.has(9)).toBe(true);
  });

  it('inference: embedded "SECTION PART %1" lvlText does NOT mark numId spec-shaped', () => {
    // Regression: an un-anchored \bPART\s*%\d matched embedded prefixes, falsely
    // marking the numId spec-shaped so inference.ts would promote unrelated ilvl=0
    // paragraphs to phantom PART headings. The "^" anchor rejects it.
    const embedded = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="8">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="SECTION PART %1"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="4"><w:abstractNumId w:val="8"/></w:num>
</w:numbering>`;
    const map = buildNumberingMap(embedded);
    expect(map.specShapedNumIds.has(4)).toBe(false);
  });
});
