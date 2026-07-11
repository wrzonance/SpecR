import { describe, it, expect } from 'vitest';
import { BorderStyle, Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import {
  buildRegionParagraph,
  ruleLineBorder,
  type HeaderFooterRegion,
  type HeaderFooterRuleLine,
} from './header-footer-regions.js';
import type { HeaderFooterCell, HeaderFooterFieldContext } from './header-footer-fields.js';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '09 91 26',
  sectionTitle: 'EXTERIOR PAINTING',
  current: {},
};

function literalCell(text: string): HeaderFooterCell {
  return { content: [{ kind: 'literal', text }] };
}

async function renderParagraphsToXml(paragraphs: readonly Paragraph[]): Promise<string> {
  const doc = new Document({ sections: [{ children: [...paragraphs] }] });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

// Strips every properly-wrapped `<w:r>...<w:tab/>...</w:r>` span. Anything
// left over that still contains `<w:tab/>` is a bare tab emitted as a direct
// `Paragraph` child — invalid OOXML (see buildRegionParagraph's doc comment
// and header-footer-regions.ts's `tabRun`).
function withWrappedTabsRemoved(xml: string): string {
  return xml.replace(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:tab\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, '');
}

function countTabs(xml: string): number {
  return (xml.match(/<w:tab\/>/g) ?? []).length;
}

describe('ruleLineBorder', () => {
  it('is undefined when the rule line is absent', () => {
    expect(ruleLineBorder(undefined)).toBeUndefined();
  });

  it('is undefined when enabled is not exactly true', () => {
    expect(ruleLineBorder({})).toBeUndefined();
    expect(ruleLineBorder({ enabled: false })).toBeUndefined();
  });

  it('converts widthTwips to w:sz at the verified ratio (widthTwips=8 -> size=3)', () => {
    expect(ruleLineBorder({ enabled: true, widthTwips: 8 })).toEqual({
      style: BorderStyle.SINGLE,
      size: 3,
    });
  });

  it('never returns a border below the MIN_BORDER_SIZE floor for an enabled rule line', () => {
    const widths: readonly (number | undefined)[] = [undefined, 0, 1, 2, 3, 8, 100];
    for (const widthTwips of widths) {
      const rule: HeaderFooterRuleLine =
        widthTwips === undefined ? { enabled: true } : { enabled: true, widthTwips };
      const border = ruleLineBorder(rule);
      expect(border).toBeDefined();
      expect(border?.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('includes color only when the rule line sets one (exactOptionalPropertyTypes-safe)', () => {
    expect('color' in (ruleLineBorder({ enabled: true, widthTwips: 8 }) ?? {})).toBe(false);
    expect(ruleLineBorder({ enabled: true, widthTwips: 8, color: 'FF0000' })).toEqual({
      style: BorderStyle.SINGLE,
      size: 3,
      color: 'FF0000',
    });
  });

  it('maps a known style keyword and falls back to SINGLE for an unrecognized/absent one', () => {
    expect(ruleLineBorder({ enabled: true, style: 'double' })?.style).toBe(BorderStyle.DOUBLE);
    expect(ruleLineBorder({ enabled: true, style: 'not-a-real-style' })?.style).toBe(
      BorderStyle.SINGLE
    );
    expect(ruleLineBorder({ enabled: true })?.style).toBe(BorderStyle.SINGLE);
  });
});

describe('buildRegionParagraph — presence invariant', () => {
  it('is undefined for an undefined region', () => {
    expect(buildRegionParagraph(undefined, undefined, CTX, 'bottom')).toBeUndefined();
  });

  it('is undefined for a region with empty cells and no enabled rule line', () => {
    const region: HeaderFooterRegion = { left: {}, ruleLine: { enabled: false } };
    expect(buildRegionParagraph(region, undefined, CTX, 'bottom')).toBeUndefined();
  });

  it('emits exactly one bordered, contentless paragraph when the rule line is enabled but every cell is empty', async () => {
    const region: HeaderFooterRegion = { ruleLine: { enabled: true, widthTwips: 8 } };
    const paragraph = buildRegionParagraph(region, undefined, CTX, 'bottom');
    expect(paragraph).toBeInstanceOf(Paragraph);
    if (paragraph === undefined) throw new Error('unreachable');
    const xml = await renderParagraphsToXml([paragraph]);
    expect(xml).toContain('<w:pBdr><w:bottom w:val="single" w:sz="3"/></w:pBdr>');
    expect(xml).not.toContain('<w:t ');
    expect(countTabs(xml)).toBe(0);
  });
});

describe('buildRegionParagraph — never emits a bare Tab as a direct paragraph child', () => {
  const scenarios: Record<string, HeaderFooterRegion> = {
    'left + center + right all populated': {
      left: literalCell('LEFT'),
      center: literalCell('CENTER'),
      right: literalCell('RIGHT'),
    },
    'left + right populated, center empty': {
      left: literalCell('LEFT'),
      right: literalCell('RIGHT'),
    },
    'only right populated': { right: literalCell('RIGHT') },
    'only left populated': { left: literalCell('LEFT') },
    'only center populated': { center: literalCell('CENTER') },
  };

  for (const [name, region] of Object.entries(scenarios)) {
    it(name, async () => {
      const paragraph = buildRegionParagraph(region, undefined, CTX, 'bottom');
      expect(paragraph).toBeInstanceOf(Paragraph);
      if (paragraph === undefined) throw new Error('unreachable');
      const xml = await renderParagraphsToXml([paragraph]);
      expect(withWrappedTabsRemoved(xml)).not.toContain('<w:tab/>');
    });
  }
});

describe('buildRegionParagraph — tab-stop count follows Word tab semantics, not cell emptiness', () => {
  // A tab always jumps to the NEXT tab stop from the current cursor position,
  // regardless of what (if anything) sits before it. A left+right-only
  // region legitimately emits TWO tabs — one to clear the (empty) center
  // stop, one to reach the right stop — even though center has no content.
  // This is correct Word layout, not a bug: collapsing it to one tab would
  // land "RIGHT" at the center tab stop instead of the right margin.
  it('left + right populated, center empty -> exactly two tabs', async () => {
    const region: HeaderFooterRegion = { left: literalCell('LEFT'), right: literalCell('RIGHT') };
    const paragraph = buildRegionParagraph(region, undefined, CTX, 'bottom');
    if (paragraph === undefined) throw new Error('unreachable');
    const xml = await renderParagraphsToXml([paragraph]);
    expect(countTabs(xml)).toBe(2);
  });

  it('only left populated -> zero tabs (nothing further right to reach)', async () => {
    const region: HeaderFooterRegion = { left: literalCell('LEFT') };
    const paragraph = buildRegionParagraph(region, undefined, CTX, 'bottom');
    if (paragraph === undefined) throw new Error('unreachable');
    const xml = await renderParagraphsToXml([paragraph]);
    expect(countTabs(xml)).toBe(0);
  });

  it('only center populated -> exactly one tab (to reach the center stop)', async () => {
    const region: HeaderFooterRegion = { center: literalCell('CENTER') };
    const paragraph = buildRegionParagraph(region, undefined, CTX, 'bottom');
    if (paragraph === undefined) throw new Error('unreachable');
    const xml = await renderParagraphsToXml([paragraph]);
    expect(countTabs(xml)).toBe(1);
  });

  it('left + center + right all populated -> exactly two tabs', async () => {
    const region: HeaderFooterRegion = {
      left: literalCell('LEFT'),
      center: literalCell('CENTER'),
      right: literalCell('RIGHT'),
    };
    const paragraph = buildRegionParagraph(region, undefined, CTX, 'bottom');
    if (paragraph === undefined) throw new Error('unreachable');
    const xml = await renderParagraphsToXml([paragraph]);
    expect(countTabs(xml)).toBe(2);
  });
});

describe('buildRegionParagraph — layout and style', () => {
  it('defines CENTER and RIGHT tab stops at the standard positions', async () => {
    const region: HeaderFooterRegion = {
      left: literalCell('LEFT'),
      center: literalCell('CENTER'),
      right: literalCell('RIGHT'),
    };
    const paragraph = buildRegionParagraph(region, undefined, CTX, 'bottom');
    if (paragraph === undefined) throw new Error('unreachable');
    const xml = await renderParagraphsToXml([paragraph]);
    expect(xml).toContain('<w:tab w:val="center" w:pos="4513"/>');
    expect(xml).toContain('<w:tab w:val="right" w:pos="9026"/>');
  });

  it('ruleLineEdge selects which paragraph border edge carries the rule line', async () => {
    const region: HeaderFooterRegion = { ruleLine: { enabled: true, widthTwips: 8 } };
    const topXml = await renderParagraphsToXml([
      buildRegionParagraph(region, undefined, CTX, 'top') as Paragraph,
    ]);
    const bottomXml = await renderParagraphsToXml([
      buildRegionParagraph(region, undefined, CTX, 'bottom') as Paragraph,
    ]);
    expect(topXml).toContain('<w:pBdr><w:top w:val="single" w:sz="3"/></w:pBdr>');
    expect(bottomXml).toContain('<w:pBdr><w:bottom w:val="single" w:sz="3"/></w:pBdr>');
  });

  it('cascades region.style over inheritedStyle down into cell runs', async () => {
    const region: HeaderFooterRegion = { left: literalCell('LEFT'), style: { bold: true } };
    const paragraph = buildRegionParagraph(region, { fontFamily: 'Arial' }, CTX, 'bottom');
    if (paragraph === undefined) throw new Error('unreachable');
    const xml = await renderParagraphsToXml([paragraph]);
    expect(xml).toMatch(/<w:b\/>/);
    expect(xml).toContain('w:ascii="Arial"');
  });
});
