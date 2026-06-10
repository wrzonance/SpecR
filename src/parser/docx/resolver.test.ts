import { describe, it, expect } from 'vitest';
import {
  extractRunProps,
  extractParaProps,
  parseStylesFull,
  mergeStyleProps,
  resolveStyleChain,
  resolveNumberingFor,
} from './resolver.js';
import { buildStyleMap } from './styles.js';
import { buildNumberingMap } from './numbering.js';

describe('extractRunProps', () => {
  it('reads fonts, size, toggles, underline, color from a w:rPr object', () => {
    const rPr = {
      'w:rFonts': { '@_w:ascii': 'Courier New' },
      'w:sz': { '@_w:val': 20 },
      'w:b': '', // fxp emits '' for self-closing <w:b/>

      'w:i': { '@_w:val': '0' }, // explicit off → false
      'w:caps': { '@_w:val': '1' }, // explicit on → true
      'w:u': { '@_w:val': 'single' },
      'w:color': { '@_w:val': 'FF0000' },
    };
    expect(extractRunProps(rPr)).toEqual({
      rFonts: { ascii: 'Courier New' },
      sz: 20,
      b: true,
      i: false,
      caps: true,
      u: 'single',
      color: 'FF0000',
    });
  });

  it('returns an empty object for an empty w:rPr', () => {
    expect(extractRunProps({})).toEqual({});
  });
});

describe('extractParaProps', () => {
  it('reads spacing, indent, alignment from a w:pPr object', () => {
    const pPr = {
      'w:spacing': { '@_w:before': 0, '@_w:after': 120, '@_w:line': 360, '@_w:lineRule': 'auto' },
      'w:ind': { '@_w:left': 720, '@_w:hanging': 360 },
      'w:jc': { '@_w:val': 'both' },
    };
    expect(extractParaProps(pPr)).toEqual({
      spacing: { before: 0, after: 120, line: 360, lineRule: 'auto' },
      ind: { left: 720, hanging: 360 },
      jc: 'both',
    });
  });

  it('extracts contextualSpacing (a w:pPr sibling) under spacing', () => {
    expect(extractParaProps({ 'w:contextualSpacing': '' })).toEqual({
      spacing: { contextualSpacing: true },
    });
  });

  it('returns an empty object for an empty w:pPr', () => {
    expect(extractParaProps({})).toEqual({});
  });
});

const STYLES_XML = `<?xml version="1.0"?>
<w:styles xmlns:w="x">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="PRT"><w:name w:val="Part"/><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:pPr><w:jc w:val="center"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="PR1"><w:basedOn w:val="PRT"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
  <w:style w:type="character" w:styleId="IP"><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

describe('parseStylesFull', () => {
  it('extracts docDefaults + paragraph styles (own props) + basedOn, skipping character styles', () => {
    const parsed = parseStylesFull(STYLES_XML);
    expect(parsed.docDefaults).toEqual({
      rPr: { rFonts: { ascii: 'Times New Roman' }, sz: 22 },
      pPr: { spacing: { after: 0 } },
    });
    expect(parsed.styles.get('IP')).toBeUndefined(); // character style skipped
    const prt = parsed.styles.get('PRT');
    expect(prt?.own).toEqual({ rPr: { b: true, sz: 20 }, pPr: { jc: 'center' } });
    expect(prt?.basedOn).toBeUndefined();
    const pr1 = parsed.styles.get('PR1');
    expect(pr1?.basedOn).toBe('PRT');
    expect(pr1?.own).toEqual({ pPr: { ind: { left: 720 } } });
  });

  it('returns empty docDefaults + empty map for styles.xml with no w:styles root', () => {
    const parsed = parseStylesFull('<?xml version="1.0"?><other/>');
    expect(parsed.docDefaults).toEqual({});
    expect(parsed.styles.size).toBe(0);
  });
});

describe('mergeStyleProps (value last-wins; nested deep-merge)', () => {
  it('overrides value props and merges nested rPr/pPr', () => {
    const base = { rPr: { sz: 22, b: false }, pPr: { spacing: { after: 0 } } };
    const over = { rPr: { sz: 20 }, pPr: { ind: { left: 720 } } };
    expect(mergeStyleProps(base, over)).toEqual({
      rPr: { sz: 20, b: false },
      pPr: { spacing: { after: 0 }, ind: { left: 720 } },
    });
  });
  it('does NOT mutate its inputs', () => {
    const base = { rPr: { sz: 22 } };
    const over = { rPr: { sz: 20 } };
    mergeStyleProps(base, over);
    expect(base).toEqual({ rPr: { sz: 22 } });
    expect(over).toEqual({ rPr: { sz: 20 } });
  });
  it('deep-merges nested rFonts, preserving sibling keys', () => {
    expect(
      mergeStyleProps(
        { rPr: { rFonts: { ascii: 'A', hAnsi: 'A' } } },
        { rPr: { rFonts: { ascii: 'B' } } }
      )
    ).toEqual({ rPr: { rFonts: { ascii: 'B', hAnsi: 'A' } } });
  });
});

describe('resolveStyleChain', () => {
  const XML = `<?xml version="1.0"?>
  <w:styles xmlns:w="x">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:styleId="PRT"><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="PR1"><w:basedOn w:val="PRT"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
  </w:styles>`;
  it('layers docDefaults -> basedOn parent -> own (closest wins)', () => {
    expect(resolveStyleChain('PR1', parseStylesFull(XML))).toEqual({
      rPr: { rFonts: { ascii: 'Times New Roman' }, sz: 20, b: true },
      pPr: { ind: { left: 720 } },
    });
  });
  it('tolerates a missing basedOn target (resolves what exists)', () => {
    const parsed = parseStylesFull(
      `<w:styles xmlns:w="x"><w:style w:type="paragraph" w:styleId="X"><w:basedOn w:val="Ghost"/><w:rPr><w:i/></w:rPr></w:style></w:styles>`
    );
    expect(resolveStyleChain('X', parsed)).toEqual({ rPr: { i: true } });
  });
  it('terminates on a basedOn cycle without infinite recursion', () => {
    const parsed = parseStylesFull(
      `<w:styles xmlns:w="x">
        <w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
        <w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style>
      </w:styles>`
    );
    expect(resolveStyleChain('A', parsed)).toEqual({ rPr: { sz: 20 } });
  });
});

describe('resolveNumberingFor', () => {
  const STYLES = `<?xml version="1.0"?><w:styles xmlns:w="x">
    <w:style w:type="paragraph" w:styleId="PRT"><w:pPr><w:numPr><w:numId w:val="2"/><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Body"/>
  </w:styles>`;
  const NUMBERING = `<?xml version="1.0"?><w:numbering xmlns:w="x">
    <w:abstractNum w:abstractNumId="5">
      <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="PART %1 -"/><w:start w:val="1"/></w:lvl>
    </w:abstractNum>
    <w:num w:numId="2"><w:abstractNumId w:val="5"/></w:num>
  </w:numbering>`;

  it('resolves ilvl/numFmt/lvlText/start for a numbered style', () => {
    const styleMap = buildStyleMap(STYLES);
    const numberingMap = buildNumberingMap(NUMBERING);
    expect(resolveNumberingFor('PRT', styleMap, numberingMap)).toEqual({
      ilvl: 0,
      numFmt: 'decimal',
      lvlText: 'PART %1 -',
      start: 1,
    });
  });

  it('returns undefined for a style with no resolved numPr', () => {
    const styleMap = buildStyleMap(STYLES);
    const numberingMap = buildNumberingMap(NUMBERING);
    expect(resolveNumberingFor('Body', styleMap, numberingMap)).toBeUndefined();
  });

  it('returns just { ilvl } when the numId is not defined in numbering.xml', () => {
    const styleMap = buildStyleMap(STYLES);
    const empty = buildNumberingMap('<?xml version="1.0"?><w:numbering xmlns:w="x"/>');
    expect(resolveNumberingFor('PRT', styleMap, empty)).toEqual({ ilvl: 0 });
  });
});
