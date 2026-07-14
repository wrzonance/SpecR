import { describe, it, expect } from 'vitest';
import { ParserError } from '../error.js';
import { captureRegion } from './header-footer-region.js';

const KNOWN = { section: '09 91 26', title: 'STAINING AND TRANSPARENT FINISHING' };

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function makeHdrXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bodyXml}</w:hdr>`;
}

function makeFtrXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>${bodyXml}</w:ftr>`;
}

function paragraph(pPrXml: string, runsXml: string): string {
  const pPr = pPrXml === '' ? '' : `<w:pPr>${pPrXml}</w:pPr>`;
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

function textRun(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

function tabRun(): string {
  return '<w:r><w:tab/></w:r>';
}

function drawingRun(): string {
  return '<w:r><w:drawing><wp:inline/></w:drawing></w:r>';
}

function fieldRuns(instr: string, cachedText: string): string {
  return (
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText>${instr}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${cachedText}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  );
}

function tableXml(): string {
  return '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
}

describe('captureRegion — cell capture and tab-boundary splitting', () => {
  it('puts all content in left when the paragraph has no tab boundaries', () => {
    const xml = makeHdrXml(paragraph('', textRun('Draft Copy')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Draft Copy' }]);
    expect(result.region?.center).toBeUndefined();
    expect(result.region?.right).toBeUndefined();
    expect(result.unmodeled).toEqual([]);
  });

  it('assigns a single tab boundary to left/center by convention (ADR-068)', () => {
    const xml = makeHdrXml(
      paragraph('', `${textRun('Left text')}${tabRun()}${textRun('Second text')}`)
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Left text' }]);
    expect(result.region?.center?.content).toEqual([{ kind: 'literal', text: 'Second text' }]);
    expect(result.region?.right).toBeUndefined();
  });

  it('captures left/center/right cells split on 2 tab boundaries, mapping known literals to fields', () => {
    const xml = makeHdrXml(
      paragraph(
        '',
        `${textRun('09 91 26')}${tabRun()}${textRun('STAINING AND TRANSPARENT FINISHING')}${tabRun()}${textRun('Confidential')}`
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'sectionNumber' }]);
    expect(result.region?.center?.content).toEqual([{ kind: 'sectionTitle' }]);
    expect(result.region?.right?.content).toEqual([{ kind: 'literal', text: 'Confidential' }]);
    expect(result.unmodeled).toEqual([]);
  });

  // KNOWN AMBIGUITY (ADR-068, CLAUDE.md OOXML ambiguity rule): a paragraph
  // with 3+ tab stops has no 4th cell to hold the extra content. The
  // overflow segment folds into `right` and is ALSO preserved as an
  // unmodeled entry — its intended cell placement genuinely cannot be
  // recovered from the OOXML.
  it('KNOWN AMBIGUITY: folds a 4th+ tab-separated segment into right and flags it unmodeled', () => {
    const xml = makeHdrXml(
      paragraph(
        '',
        `${textRun('A')}${tabRun()}${textRun('B')}${tabRun()}${textRun('C')}${tabRun()}${textRun('D')}`
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'A' }]);
    expect(result.region?.center?.content).toEqual([{ kind: 'literal', text: 'B' }]);
    expect(result.region?.right?.content).toEqual([
      { kind: 'literal', text: 'C' },
      { kind: 'literal', text: 'D' },
    ]);
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'unrecognizedField' })
    );
  });

  it('captures a recognized field code (PAGE) as a modeled field, not literal text', () => {
    const xml = makeHdrXml(paragraph('', `${textRun('Page ')}${fieldRuns(' PAGE ', '3')}`));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([
      { kind: 'literal', text: 'Page ' },
      { kind: 'pageNumber' },
    ]);
    expect(result.unmodeled).toEqual([]);
  });

  it('preserves an unrecognized field code (e.g. STYLEREF) as unmodeled, never guessed into a known field', () => {
    const xml = makeHdrXml(paragraph('', fieldRuns(' STYLEREF "Heading 1" ', 'Section Title')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'unrecognizedField' })
    );
  });

  it('captures an image run as unmodeled, never as cell content', () => {
    const xml = makeHdrXml(paragraph('', `${textRun('Logo: ')}${drawingRun()}`));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Logo: ' }]);
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'image' })
    );
  });
});

describe('captureRegion — INVARIANT: at most one captured region per part', () => {
  it('captures only the first content-bearing paragraph; a second is preserved as unmodeled extraParagraph, never merged', () => {
    const xml = makeHdrXml(
      `${paragraph('', textRun('First paragraph'))}${paragraph('', textRun('Second paragraph'))}`
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'First paragraph' }]);
    expect(result.unmodeled).toHaveLength(1);
    expect(result.unmodeled[0]).toMatchObject({
      variant: 'default',
      region: 'header',
      kind: 'extraParagraph',
    });
  });

  it('a third and later content-bearing paragraph is also unmodeled, never overwriting the first capture', () => {
    const xml = makeHdrXml(
      `${paragraph('', textRun('First'))}${paragraph('', textRun('Second'))}${paragraph('', textRun('Third'))}`
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'First' }]);
    expect(result.unmodeled.filter((u) => u.kind === 'extraParagraph')).toHaveLength(2);
  });

  it('an empty (non-content-bearing) leading paragraph is skipped, not counted as the captured region', () => {
    const xml = makeHdrXml(`${paragraph('', '')}${paragraph('', textRun('Real content'))}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Real content' }]);
    expect(result.unmodeled).toEqual([]);
  });

  it('returns region undefined and no unmodeled entries when no paragraph has recognizable content', () => {
    const xml = makeHdrXml(paragraph('', ''));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toEqual([]);
  });
});

describe('captureRegion — INVARIANT: w:tbl is detected at the part root, not inside a paragraph', () => {
  it('detects a w:tbl as a root-level sibling of w:p and preserves it as unmodeled', () => {
    const xml = makeHdrXml(`${paragraph('', textRun('Header text'))}${tableXml()}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Header text' }]);
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'table' })
    );
  });

  it('never reports a table when no w:tbl exists anywhere in the part', () => {
    const xml = makeHdrXml(paragraph('', textRun('No table here')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.unmodeled.some((u) => u.kind === 'table')).toBe(false);
  });

  it('detects multiple root-level w:tbl elements, one unmodeled entry per table', () => {
    const xml = makeHdrXml(`${paragraph('', textRun('Text'))}${tableXml()}${tableXml()}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.unmodeled.filter((u) => u.kind === 'table')).toHaveLength(2);
  });
});

describe('captureRegion — rule line (paragraph border passthrough)', () => {
  it('captures a bottom border on a header edge as a verbatim style passthrough', () => {
    const xml = makeHdrXml(
      paragraph(
        '<w:pBdr><w:bottom w:val="single" w:sz="4" w:color="000000"/></w:pBdr>',
        textRun('Header')
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.ruleLine).toEqual({
      enabled: true,
      style: 'single',
      widthTwips: 10,
      color: '000000',
    });
  });

  it('reads the top border for a footer edge, ignoring an unrelated bottom border', () => {
    const xml = makeFtrXml(
      paragraph(
        '<w:pBdr><w:top w:val="double" w:sz="8"/><w:bottom w:val="single" w:sz="4"/></w:pBdr>',
        textRun('Footer')
      )
    );
    const result = captureRegion(xml, 'top', 'default', 'footer', KNOWN);
    expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'double', widthTwips: 20 });
  });

  it('treats w:val="nil" as no rule line at all, not enabled:false', () => {
    const xml = makeHdrXml(
      paragraph('<w:pBdr><w:bottom w:val="nil"/></w:pBdr>', textRun('Header'))
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.ruleLine).toBeUndefined();
  });

  it('is undefined when the paragraph has no w:pBdr at all', () => {
    const xml = makeHdrXml(paragraph('', textRun('Header')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.ruleLine).toBeUndefined();
  });
});

describe('captureRegion — malformed/absent input handling', () => {
  it('returns region undefined and empty unmodeled for a part whose root element is missing entirely', () => {
    const xml = `<?xml version="1.0"?><w:something ${NS}/>`;
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result).toEqual({ region: undefined, unmodeled: [] });
  });

  it('throws ParserError DOCX_HEADER_FOOTER_XML_INVALID with cause for malformed part XML', () => {
    let caught: unknown;
    try {
      captureRegion('<not valid xml', 'bottom', 'default', 'header', KNOWN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
  });
});
