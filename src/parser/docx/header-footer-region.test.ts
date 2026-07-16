import { describe, it, expect } from 'vitest';
import { ParserError } from '../error.js';
import {
  captureRegion,
  paragraphHasContent,
  paragraphsOf,
  runsOf,
} from './header-footer-region.js';
import { asRecord, compact, createDocumentXmlParser } from './xml-utils.js';
import { collectRuns } from './document.js';
import { RELS_UNREADABLE_REASON } from './header-footer-media-parts.js';
import type { HeaderFooterPartMedia } from './header-footer-media-parts.js';

const KNOWN = { section: '09 91 26', title: 'STAINING AND TRANSPARENT FINISHING' };

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function makeHdrXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bodyXml}</w:hdr>`;
}

// Mirrors header-footer-region.ts's own partParser config exactly (same
// isArray tag set) so tests can independently re-parse a header part and
// assert on the SAME raw paragraph records captureRegion itself works from —
// used to pin the "detail === compact(paragraph)" losslessness invariant
// (#484 review) without reaching into the module's internal parser. Same
// idiom as header-footer-images.test.ts's own partParser.
const testPartParser = createDocumentXmlParser([
  'w:p',
  'w:r',
  'w:tbl',
  'w:tr',
  'w:tc',
  'w:gridCol',
]);

function parseHeaderParagraphs(xml: string): readonly Record<string, unknown>[] {
  const parsed = testPartParser.parse(xml) as Record<string, unknown>;
  const root = asRecord(parsed['w:hdr']);
  if (!root) throw new Error('test fixture parse failure: no w:hdr root');
  return paragraphsOf(root);
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

// Word's single-tag field shorthand (#485) — @_w:instr carries the field
// code, and the cached display text sits in a nested w:r, parallel to
// fieldRuns' w:fldChar begin/separate/end sequence above.
function simpleFieldRun(instr: string, cachedText: string): string {
  return `<w:fldSimple w:instr="${instr}"><w:r><w:t>${cachedText}</w:t></w:r></w:fldSimple>`;
}

function tableXml(): string {
  return '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
}

function hyperlinkRun(text: string): string {
  return `<w:hyperlink r:id="rId9">${textRun(text)}</w:hyperlink>`;
}

function insertedRun(text: string): string {
  return `<w:ins w:id="1" w:author="Editor">${textRun(text)}</w:ins>`;
}

function deletedRun(text: string): string {
  return `<w:del w:id="2" w:author="Editor"><w:r><w:delText>${text}</w:delText></w:r></w:del>`;
}

function sdtRun(text: string): string {
  return `<w:sdt><w:sdtPr><w:id w:val="123"/></w:sdtPr><w:sdtContent>${textRun(text)}</w:sdtContent></w:sdt>`;
}

function styledTextRun(text: string, rPrXml: string): string {
  return `<w:r><w:rPr>${rPrXml}</w:rPr><w:t>${text}</w:t></w:r>`;
}

// ─── image-resolving drawing run fixtures (#487) — a well-formed w:drawing
// whose rId/EMU size/blip chain mirror header-footer-images.test.ts's own
// wellFormedDrawing fixture, but as raw XML text (captureRegion's own input
// shape) rather than a pre-parsed record.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(totalLength = 16): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  bytes.set(PNG_SIGNATURE);
  return bytes;
}

function imageDrawingRun(rId: string, cx = '914400', cy = '609600', docPrAttrs = ''): string {
  return (
    '<w:r><w:drawing><wp:inline>' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="1" ${docPrAttrs}/>` +
    '<a:graphic><a:graphicData><pic:pic><pic:blipFill>' +
    `<a:blip r:embed="${rId}"/>` +
    '</pic:blipFill></pic:pic></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>'
  );
}

function tableXmlWithImageCell(rId: string): string {
  return `<w:tbl><w:tr><w:tc><w:p>${imageDrawingRun(rId)}</w:p></w:tc></w:tr></w:tbl>`;
}

// Wraps a plain rId -> bytes fixture into the `resolved` HeaderFooterPartMedia
// shape captureRegion now expects (#502).
function resolvedMedia(entries: readonly (readonly [string, Uint8Array])[]): HeaderFooterPartMedia {
  return { status: 'resolved', media: new Map(entries) };
}

// The #502 counterpart: the part's own .rels file could not be read/parsed
// at all, so every reference into it is unresolvable by construction.
function relsUnreadableMedia(partPath = 'word/header1.xml'): HeaderFooterPartMedia {
  return { status: 'relsUnreadable', partPath };
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

  it('a bare trailing tab (empty 4th segment) fills left/center/right without a spurious overflow warning', () => {
    // 3 tabs after 3 content runs yields a 4th, EMPTY segment — nothing is
    // actually folded past `right`, so the "extra content folded into right"
    // warning (gated on segment content, not count) must NOT fire.
    const xml = makeHdrXml(
      paragraph(
        '',
        `${textRun('A')}${tabRun()}${textRun('B')}${tabRun()}${textRun('C')}${tabRun()}`
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'A' }]);
    expect(result.region?.center?.content).toEqual([{ kind: 'literal', text: 'B' }]);
    expect(result.region?.right?.content).toEqual([{ kind: 'literal', text: 'C' }]);
    expect(result.unmodeled).toEqual([]);
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

// Regression (#306 review): runsOf/paragraphHasContent only scanned a paragraph's
// direct w:r children, so header/footer content wrapped in w:hyperlink, tracked
// changes (w:ins/w:del), or a w:sdt content control was invisible to capture — it
// was silently dropped with no unmodeled entry and no warning. runsOf now deep-
// scans via document.ts's collectRuns, the same traversal already used for
// ordinary body paragraphs.
describe('captureRegion — content nested inside wrapper elements is not silently dropped (#306 review)', () => {
  it('captures text wrapped in w:hyperlink as ordinary cell content', () => {
    const xml = makeHdrXml(paragraph('', hyperlinkRun('Linked Text')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Linked Text' }]);
    expect(result.unmodeled).toEqual([]);
  });

  it('captures text wrapped in a tracked-change insertion (w:ins) as ordinary cell content', () => {
    const xml = makeHdrXml(paragraph('', insertedRun('Inserted Text')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Inserted Text' }]);
    expect(result.unmodeled).toEqual([]);
  });

  it('captures text wrapped in a w:sdt content control as ordinary cell content', () => {
    const xml = makeHdrXml(paragraph('', sdtRun('SDT Text')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'SDT Text' }]);
    expect(result.unmodeled).toEqual([]);
  });

  it('splits on a tab boundary even when the second segment is wrapped in w:hyperlink', () => {
    const xml = makeHdrXml(
      paragraph('', `${textRun('Left text')}${tabRun()}${hyperlinkRun('Linked center')}`)
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Left text' }]);
    expect(result.region?.center?.content).toEqual([{ kind: 'literal', text: 'Linked center' }]);
  });

  it('a w:del tracked-deletion run (w:delText, not w:t) never surfaces as captured content', () => {
    const xml = makeHdrXml(paragraph('', deletedRun('Removed Text')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toEqual([]);
  });
});

// #485 traversal layer: runsOf's local collectRunsAndFields must terminate at
// a w:fldSimple element as a whole (re-wrapped as { 'w:fldSimple': element }),
// the same way it already terminates at w:r — rather than recursing into it
// and silently flattening its cached-text w:r into an ordinary literal run,
// which is what document.ts's shared collectRuns still does (and must keep
// doing, unmodified, for the ordinary body-paragraph path).
describe('runsOf / paragraphHasContent — w:fldSimple terminal handling (#485 traversal layer)', () => {
  it('paragraphHasContent recognizes a bare w:fldSimple-wrapped run as content-bearing', () => {
    expect(paragraphHasContent([{ 'w:fldSimple': { '@_w:instr': ' PAGE ' } }])).toBe(true);
  });

  it('paragraphHasContent stays false for a run with none of the recognized content keys', () => {
    expect(paragraphHasContent([{ 'w:rPr': {} }])).toBe(false);
  });

  it('collects a w:fldSimple as exactly one terminal run — no double-counting of its inner cached-text run', () => {
    const xml = makeHdrXml(paragraph('', simpleFieldRun(' PAGE ', '3')));
    const [paragraphNode] = parseHeaderParagraphs(xml);
    if (paragraphNode === undefined) throw new Error('test fixture parse failure: no paragraph');
    const runs = runsOf(paragraphNode);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveProperty('w:fldSimple');
  });

  it('finds a w:fldSimple nested inside a w:sdt content control (deep-unwrap parity with w:r)', () => {
    const wrapped = `<w:sdt><w:sdtPr><w:id w:val="1"/></w:sdtPr><w:sdtContent>${simpleFieldRun(' PAGE ', '3')}</w:sdtContent></w:sdt>`;
    const xml = makeHdrXml(paragraph('', wrapped));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'pageNumber' }]);
  });

  // #485 review (finding: traversal completeness / deep-unwrap parity): the
  // w:sdt case above is only ONE of this module's own terminal wrappers
  // (header-footer-region.ts's module comment names w:hyperlink and
  // tracked-change w:ins/w:del alongside w:sdt) — each must independently
  // prove a nested w:fldSimple is still found, not merely assumed by
  // analogy to w:sdt or to w:r's own pre-existing coverage.
  it('finds a w:fldSimple nested inside a w:hyperlink (deep-unwrap parity with w:r)', () => {
    const wrapped = `<w:hyperlink r:id="rId9">${simpleFieldRun(' PAGE ', '3')}</w:hyperlink>`;
    const xml = makeHdrXml(paragraph('', wrapped));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'pageNumber' }]);
  });

  it('finds a w:fldSimple nested inside a tracked-change insertion (w:ins) (deep-unwrap parity with w:r)', () => {
    const wrapped = `<w:ins w:id="1" w:author="Editor">${simpleFieldRun(' PAGE ', '3')}</w:ins>`;
    const xml = makeHdrXml(paragraph('', wrapped));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'pageNumber' }]);
  });

  it('finds a w:fldSimple nested inside a tracked-change deletion (w:del) (deep-unwrap parity with w:r)', () => {
    const wrapped = `<w:del w:id="2" w:author="Editor">${simpleFieldRun(' PAGE ', '3')}</w:del>`;
    const xml = makeHdrXml(paragraph('', wrapped));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'pageNumber' }]);
  });

  // #485 review (Major — data integrity): the SAME grouped-parse reordering
  // that afflicts paragraph-level runs also afflicts a w:fldSimple's own cached
  // content. A field whose cached display interleaves a direct w:r, a
  // w:hyperlink-wrapped w:r, then another direct w:r groups the two direct runs
  // apart from the wrapped one, so a grouped-order gather yields 'ACB'. The
  // per-part run-order side-table now descends into the w:fldSimple, so
  // collapseSimpleField restores true document order 'ABC' in cachedText.
  // (cachedText is surfaced on an UNRECOGNIZED field, so STYLEREF is used.)
  it('preserves document order of a w:fldSimple cached run interleaving direct and wrapper-nested runs', () => {
    const fld =
      '<w:fldSimple w:instr=" STYLEREF ">' +
      '<w:r><w:t>A</w:t></w:r>' +
      '<w:hyperlink r:id="rId9"><w:r><w:t>B</w:t></w:r></w:hyperlink>' +
      '<w:r><w:t>C</w:t></w:r>' +
      '</w:fldSimple>';
    const xml = makeHdrXml(paragraph('', fld));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    const entry = result.unmodeled.find((u) => u.kind === 'unrecognizedField');
    expect(entry?.detail).toEqual({ rawInstr: ' STYLEREF ', cachedText: 'ABC' });
  });

  // #485 review (CRITICAL finding — cross-representation equivalence): fast-
  // xml-parser's grouped (non-preserveOrder) parse mode collapses every
  // same-tag sibling into one array keyed by first appearance — when a
  // w:fldSimple sits BETWEEN two plain w:r runs, the second w:r gets merged
  // into the FIRST w:r's array instead of staying interleaved after the
  // field, silently reordering captured content. The identical field/text
  // layout authored as w:fldChar never hits this: every piece (begin/
  // instrText/separate/cached/end) is itself wrapped in w:r, so it all stays
  // under ONE 'w:r' key and true order survives. Run for both
  // representations so a regression in either direction is caught.
  it.each([
    ['w:fldChar', fieldRuns(' PAGE ', '3')],
    ['w:fldSimple', simpleFieldRun(' PAGE ', '3')],
  ])(
    'INVARIANT: preserves true document order when a %s field is interleaved between two plain w:r runs',
    (_label, fieldXml) => {
      const xml = makeHdrXml(paragraph('', `${textRun('Page ')}${fieldXml}${textRun(' of 10')}`));
      const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
      expect(result.region?.left?.content).toEqual([
        { kind: 'literal', text: 'Page ' },
        { kind: 'pageNumber' },
        { kind: 'literal', text: ' of 10' },
      ]);
      expect(result.unmodeled).toEqual([]);
    }
  );

  it('recognizes a PAGE field authored as w:fldSimple as content-bearing and captures it as a modeled field (parity with w:fldChar)', () => {
    const xml = makeHdrXml(paragraph('', `${textRun('Page ')}${simpleFieldRun(' PAGE ', '3')}`));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([
      { kind: 'literal', text: 'Page ' },
      { kind: 'pageNumber' },
    ]);
    expect(result.unmodeled).toEqual([]);
  });

  it('preserves an unrecognized field code (e.g. STYLEREF) authored as w:fldSimple as unmodeled, never guessed into a known field (parity with the w:fldChar path tested above)', () => {
    const xml = makeHdrXml(paragraph('', simpleFieldRun(' STYLEREF Heading1 ', 'Some Style Text')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'unrecognizedField' })
    );
  });

  it("document.ts's shared collectRuns is unmodified — it still flattens w:fldSimple into its inner w:r, unlike header-footer-region.ts's own local traversal", () => {
    const xml = makeHdrXml(paragraph('', simpleFieldRun(' PAGE ', '3')));
    const [paragraphNode] = parseHeaderParagraphs(xml);
    if (paragraphNode === undefined) throw new Error('test fixture parse failure: no paragraph');
    const sharedRuns: Record<string, unknown>[] = [];
    collectRuns(paragraphNode, sharedRuns);
    expect(sharedRuns).toHaveLength(1);
    expect(sharedRuns[0]).not.toHaveProperty('w:fldSimple');
    expect(sharedRuns[0]).toHaveProperty('w:t');
  });
});

describe('captureRegion — cell style capture from run properties (#306 review)', () => {
  it('maps a bold/italic/colored run onto HeaderFooterCell.style', () => {
    const xml = makeHdrXml(
      paragraph('', styledTextRun('Confidential', '<w:b/><w:i/><w:color w:val="FF0000"/>'))
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.style).toEqual({ bold: true, italic: true, color: 'FF0000' });
  });

  it('leaves style undefined for a plain run with no rPr', () => {
    const xml = makeHdrXml(paragraph('', textRun('Plain')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.style).toBeUndefined();
  });

  it('captures only the FIRST styled run per cell — a documented simplification, not per-run styling', () => {
    const xml = makeHdrXml(
      paragraph('', `${styledTextRun('Bold ', '<w:b/>')}${styledTextRun('Italic', '<w:i/>')}`)
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Bold Italic' }]);
    expect(result.region?.left?.style).toEqual({ bold: true });
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

// Deep table-shape capture (rows/cells/columnSpan/columnWidths/borders,
// nested/vMerge disqualification, first-table-wins, per-cell image/
// extraParagraph drops) is covered in header-footer-table.test.ts, which
// exercises captureTablesForRegion's own rules through this same public
// captureRegion boundary. This block covers only the region-level structural
// invariant: a root-level w:tbl is detected as a sibling of w:p (never
// inside a paragraph, ADR-068), merges into the SAME region as any captured
// paragraph cells (ADR-071), and "first table wins" the same way "first
// paragraph wins" (ADR-068).
describe('captureRegion — INVARIANT: w:tbl is a root-level sibling of w:p, captured into region.table', () => {
  it('captures a root-level w:tbl into region.table alongside a captured paragraph, in the same region', () => {
    const xml = makeHdrXml(`${paragraph('', textRun('Header text'))}${tableXml()}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Header text' }]);
    expect(result.region?.table).toEqual({
      rows: [{ cells: [{ content: [{ kind: 'literal', text: 'cell' }] }] }],
    });
    expect(result.unmodeled).toEqual([]);
  });

  it('leaves region.table undefined and reports no table unmodeled entry when no w:tbl exists', () => {
    const xml = makeHdrXml(paragraph('', textRun('No table here')));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toBeUndefined();
    expect(result.unmodeled.some((u) => u.kind === 'table')).toBe(false);
  });

  it('keeps only the first of multiple root-level w:tbl elements as region.table; the rest are unmodeled (ADR-071 "first table wins")', () => {
    const xml = makeHdrXml(`${paragraph('', textRun('Text'))}${tableXml()}${tableXml()}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toEqual({
      rows: [{ cells: [{ content: [{ kind: 'literal', text: 'cell' }] }] }],
    });
    expect(result.unmodeled.filter((u) => u.kind === 'table')).toHaveLength(1);
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

// Standalone border-only paragraph promotion/demotion (#484, ADR-068
// addendum): a rule line authored as its own otherwise-empty paragraph
// (w:pPr/w:pBdr, no runs) is not content-bearing, so it used to be filtered
// out of captureFromParagraphs entirely with no region contribution and no
// unmodeled entry — a silent drop in violation of ADR-068 acceptance
// criterion 4. resolveRuleLine now scans every paragraph (not just the
// first content-bearing one) for a qualifying border and promotes the
// first standalone match into region.ruleLine when the content-bearing
// paragraph itself carries none; any further standalone match demotes to
// an `extraParagraph` unmodeled entry, position-agnostically.
describe('captureRegion — standalone rule-line paragraph promotion/demotion (#484, ADR-068 addendum)', () => {
  it('promotes a standalone border-only paragraph to region.ruleLine when the part has no content-bearing paragraph at all', () => {
    const xml = makeHdrXml(paragraph('<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>', ''));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region).toEqual({ ruleLine: { enabled: true, style: 'single', widthTwips: 10 } });
    expect(result.unmodeled).toEqual([]);
  });

  it('promotes a leading standalone rule-line paragraph above a borderless text paragraph, not discarding it', () => {
    const xml = makeHdrXml(
      `${paragraph('<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>', '')}${paragraph('', textRun('Header text'))}`
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Header text' }]);
    expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'single', widthTwips: 10 });
    expect(result.unmodeled).toEqual([]);
  });

  it('promotes a trailing standalone rule-line paragraph below a borderless text paragraph (position-agnostic)', () => {
    const xml = makeFtrXml(
      `${paragraph('', textRun('Footer text'))}${paragraph('<w:pBdr><w:top w:val="single" w:sz="4"/></w:pBdr>', '')}`
    );
    const result = captureRegion(xml, 'top', 'default', 'footer', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Footer text' }]);
    expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'single', widthTwips: 10 });
    expect(result.unmodeled).toEqual([]);
  });

  it('promotes the first standalone rule-line paragraph and demotes a second one to an extraParagraph unmodeled entry', () => {
    // Deliberately DIFFERENT border values per paragraph (single/4 vs
    // double/8, #484 review): identical candidates can't prove document-order-
    // first promotion — a promote-the-last or promote-arbitrary bug would
    // still pass an identical-values test. The assertions below pin the
    // promoted ruleLine to the FIRST paragraph's own border, never the second.
    const firstRule = '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>';
    const secondRule = '<w:pBdr><w:bottom w:val="double" w:sz="8"/></w:pBdr>';
    const xml = makeHdrXml(`${paragraph(firstRule, '')}${paragraph(secondRule, '')}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'single', widthTwips: 10 });
    expect(result.unmodeled).toHaveLength(1);
    expect(result.unmodeled[0]).toMatchObject({
      variant: 'default',
      region: 'header',
      kind: 'extraParagraph',
    });
    // Losslessness half of the invariant (#484 review): the demoted entry's
    // `detail` is the raw SECOND paragraph record, verbatim (compact(paragraph)),
    // not a summary and not the promoted first paragraph.
    const demotedParagraph = parseHeaderParagraphs(xml)[1];
    expect(demotedParagraph).toBeDefined();
    expect(result.unmodeled[0]?.detail).toEqual(
      compact(demotedParagraph as Record<string, unknown>)
    );
  });

  // KNOWN AMBIGUITY (ADR-068 addendum, #484, CLAUDE.md OOXML ambiguity
  // rule): when a part has BOTH a standalone rule-line paragraph AND a
  // content-bearing paragraph that also carries its own border, OOXML
  // gives no canonical tiebreak for which one is "the" rule line. The
  // content-bearing paragraph's own border wins outright — matching the
  // pre-existing "first content-bearing paragraph wins" convention — and
  // the standalone paragraph demotes to an unmodeled entry instead of
  // being merged or silently dropped.
  it('KNOWN AMBIGUITY: a content-bearing paragraph’s own border wins outright over a standalone candidate', () => {
    const standaloneRule = '<w:pBdr><w:bottom w:val="double" w:sz="8"/></w:pBdr>';
    const contentRule = '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>';
    const xml = makeHdrXml(
      `${paragraph(standaloneRule, '')}${paragraph(contentRule, textRun('Header text'))}`
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'single', widthTwips: 10 });
    expect(result.unmodeled).toHaveLength(1);
    expect(result.unmodeled[0]).toMatchObject({ kind: 'extraParagraph' });
  });

  // KNOWN AMBIGUITY (ADR-068 addendum, #484 review): the same precedence as
  // above, but with the standalone candidate positioned AFTER the
  // content-bearing paragraph instead of before it — the reverse document
  // order from the test above. The content-bearing paragraph's border still
  // wins outright either way, proving the precedence "never silently varies
  // by position" (resolveRuleLine's own doc comment) rather than only
  // happening to hold for one relative ordering.
  it('KNOWN AMBIGUITY: a content-bearing paragraph’s own border wins outright over a standalone candidate positioned AFTER it', () => {
    const contentRule = '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>';
    const standaloneRule = '<w:pBdr><w:bottom w:val="double" w:sz="8"/></w:pBdr>';
    const xml = makeHdrXml(
      `${paragraph(contentRule, textRun('Header text'))}${paragraph(standaloneRule, '')}`
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Header text' }]);
    expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'single', widthTwips: 10 });
    expect(result.unmodeled).toHaveLength(1);
    expect(result.unmodeled[0]).toMatchObject({ kind: 'extraParagraph' });
  });

  // #484 review — a bordered paragraph that is non-content-bearing yet still
  // carries a run (a lone w:br) is NOT run-free, so it must never be promoted
  // into region.ruleLine: a promoted paragraph's runs are never captured, so
  // promoting this one would silently drop its w:br. It demotes to an
  // extraParagraph instead, preserving the whole paragraph verbatim (border
  // AND run) — ADR-068 criterion 4, nothing silently discarded.
  it('does not promote a bordered non-content paragraph that still has a run (w:br); preserves it verbatim as an extraParagraph', () => {
    const xml = makeHdrXml(
      paragraph('<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>', '<w:r><w:br/></w:r>')
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    // Border NOT promoted — the region has no rule line at all, rather than a
    // rule line shorn of its dropped run.
    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toHaveLength(1);
    expect(result.unmodeled[0]).toMatchObject({
      variant: 'default',
      region: 'header',
      kind: 'extraParagraph',
    });
    // Losslessness half of the invariant: the demoted entry's `detail` is the
    // raw paragraph verbatim (compact(paragraph)) — border and w:br both
    // survive in unmodeled, neither silently dropped.
    const demoted = parseHeaderParagraphs(xml)[0];
    expect(demoted).toBeDefined();
    expect(result.unmodeled[0]?.detail).toEqual(compact(demoted as Record<string, unknown>));
  });

  // #484 review — the skip-to-next-eligible half of promotion: a run-carrying
  // bordered candidate in document-order-first position must be SKIPPED (not
  // promoted), and the LATER run-free candidate promoted instead. Deliberately
  // different border values (single/4 with a w:br vs double/8 run-free) so the
  // promoted ruleLine can only be the second paragraph's border — proving
  // promotion actually advanced past the disqualified first candidate rather
  // than merely finding nothing to promote.
  it('skips a run-carrying bordered candidate and promotes the later run-free one; the skipped candidate demotes verbatim', () => {
    const runCarrying = paragraph(
      '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>',
      '<w:r><w:br/></w:r>'
    );
    const runFree = paragraph('<w:pBdr><w:bottom w:val="double" w:sz="8"/></w:pBdr>', '');
    const xml = makeHdrXml(`${runCarrying}${runFree}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    // Promoted rule line is the SECOND (run-free) paragraph's border —
    // widthTwips = round(8 / 0.4) = 20 — never the first's single/4.
    expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'double', widthTwips: 20 });
    // The skipped first candidate is preserved verbatim (border AND w:br), not
    // dropped for being passed over.
    expect(result.unmodeled).toHaveLength(1);
    expect(result.unmodeled[0]).toMatchObject({ kind: 'extraParagraph' });
    const skipped = parseHeaderParagraphs(xml)[0];
    expect(skipped).toBeDefined();
    expect(result.unmodeled[0]?.detail).toEqual(compact(skipped as Record<string, unknown>));
  });

  // #485 review — a SECOND content-bearing paragraph (border AND field) still
  // demotes whole via the pre-existing extraParagraph path (INVARIANT block
  // above), exactly like any other second content-bearing paragraph. NOTE:
  // this scenario alone does NOT discriminate "excluded from
  // resolveRuleLine's candidate list because content-bearing" from a
  // regressed "included as a candidate but disqualified from promotion
  // because runsOf still finds its field as one run" — both paths produce
  // the identical extraParagraph/detail output here. The single-paragraph
  // test below (real protection for resolveRuleLine's candidate filter) is
  // what actually distinguishes them; this test documents the
  // multiple-content-bearing-paragraph invariant on its own terms.
  it.each([
    ['w:fldChar', fieldRuns(' STYLEREF Heading1 ', 'Some Style Text')],
    ['w:fldSimple', simpleFieldRun(' STYLEREF Heading1 ', 'Some Style Text')],
  ])(
    'a run-free paragraph with a border AND a field (%s) demotes whole as a second content-bearing paragraph — its border is never separately promoted',
    (_label, fieldXml) => {
      const border = '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>';
      const xml = makeHdrXml(
        `${paragraph('', textRun('Header text'))}${paragraph(border, fieldXml)}`
      );
      const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);

      expect(result.region?.left?.content).toEqual([{ kind: 'literal', text: 'Header text' }]);
      expect(result.region?.ruleLine).toBeUndefined();
      expect(result.unmodeled).toHaveLength(1);
      expect(result.unmodeled[0]).toMatchObject({
        variant: 'default',
        region: 'header',
        kind: 'extraParagraph',
      });
      // Losslessness half of the invariant: the demoted entry's `detail` is
      // the raw SECOND paragraph verbatim (compact(paragraph)) — border and
      // field both survive in unmodeled, neither silently dropped.
      const secondParagraph = parseHeaderParagraphs(xml)[1];
      expect(secondParagraph).toBeDefined();
      expect(result.unmodeled[0]?.detail).toEqual(
        compact(secondParagraph as Record<string, unknown>)
      );
    }
  );

  // #485 review — the actual, discriminating protection for resolveRuleLine's
  // candidate filter: a SOLE bordered paragraph whose only content is a
  // field. If paragraphHasContent ever regressed to stop recognizing this
  // field, the paragraph would drop out of `contentBearing` entirely (no
  // `first`, so no cell content) AND separately fail resolveRuleLine's
  // run-free promotion check (its field still counts as one run via runsOf,
  // so `runsOf(...).length === 0` is false) — losing BOTH the modeled
  // content and the ruleLine, with the whole paragraph demoted as an
  // unpromoted extraParagraph instead. Only a SINGLE paragraph (not a
  // second, already-demoted one) makes those two outcomes observably
  // different through captureRegion's own output.
  it.each([
    ['w:fldChar', fieldRuns(' PAGE ', '3')],
    ['w:fldSimple', simpleFieldRun(' PAGE ', '3')],
  ])(
    'a bordered paragraph whose only content is a field (%s) is captured as content AND ruleLine — never excluded as a run-free candidate (protects resolveRuleLine)',
    (_label, fieldXml) => {
      const border = '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>';
      const xml = makeHdrXml(paragraph(border, fieldXml));
      const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);

      expect(result.unmodeled).toEqual([]);
      expect(result.region?.ruleLine).toEqual({ enabled: true, style: 'single', widthTwips: 10 });
      expect(result.region?.left?.content).toEqual([{ kind: 'pageNumber' }]);
    }
  );

  it('regression guard: a part with no paragraphs at all still returns region undefined and unmodeled empty', () => {
    const xml = makeHdrXml('');
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toEqual([]);
  });
});

// Image resolution wiring (#487, Task 4): captureRegion's new optional 6th
// param (partMedia) threads through captureFromParagraphs ->
// splitParagraphIntoCells -> assignSegmentsToCells -> buildCellContent, which
// gains a drawing branch (isDrawingRun -> resolveDrawingImage) alongside its
// existing collapsed-field/text branches. Deep resolution behavior itself
// (descriptor parsing, byte lookup, sniff, size cap) is pinned in
// header-footer-images.test.ts; this file pins only the two invariants that
// live at THIS boundary — table-cell exclusion and run-order preservation.
describe('captureRegion — image resolution wiring (#487)', () => {
  it('INVARIANT: a table-cell drawing run never produces a kind:"image" field, even when partMedia would resolve it', () => {
    const rId = 'rId5';
    const bytes = pngBytes();
    const partMedia = resolvedMedia([[rId, bytes]]);
    const xml = makeHdrXml(tableXmlWithImageCell(rId));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN, partMedia);

    const cellContent = result.region?.table?.rows[0]?.cells[0]?.content ?? [];
    expect(cellContent.some((field) => field.kind === 'image')).toBe(false);
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'image' })
    );
  });

  it('resolves a paragraph-level drawing run to a modeled image field when partMedia supplies matching bytes', () => {
    const rId = 'rId9';
    const bytes = pngBytes();
    const partMedia = resolvedMedia([[rId, bytes]]);
    const xml = makeHdrXml(paragraph('', imageDrawingRun(rId)));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN, partMedia);

    expect(result.region?.left?.content).toEqual([
      {
        kind: 'image',
        imageData: Buffer.from(bytes).toString('base64'),
        imageMediaType: 'image/png',
        widthEmu: 914400,
        heightEmu: 609600,
      },
    ]);
    expect(result.unmodeled).toEqual([]);
  });

  it('falls back to the pre-existing unmodeled image entry when no partMedia is supplied (backward compatible)', () => {
    const rId = 'rId9';
    const xml = makeHdrXml(paragraph('', imageDrawingRun(rId)));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);

    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'image' })
    );
  });

  // #502: a relsUnreadable partMedia degrades a paragraph-level drawing to
  // unresolvedReference (rId + part + reason), not the generic kind:'image'
  // fallback the "no partMedia supplied" case above still uses — proving the
  // two failure modes (no media at all vs. a damaged part's own .rels) are
  // distinguishable at this same boundary.
  it('resolves a paragraph-level drawing run in a relsUnreadable part to unresolvedReference, never kind:"image"', () => {
    const rId = 'rId9';
    const xml = makeHdrXml(paragraph('', imageDrawingRun(rId)));
    const result = captureRegion(
      xml,
      'bottom',
      'default',
      'header',
      KNOWN,
      relsUnreadableMedia('word/header1.xml')
    );

    expect(result.region).toBeUndefined();
    expect(result.unmodeled).toContainEqual({
      variant: 'default',
      region: 'header',
      kind: 'unresolvedReference',
      detail: { rId, part: 'word/header1.xml', reason: RELS_UNREADABLE_REASON },
    });
    expect(result.unmodeled.some((e) => e.kind === 'image')).toBe(false);
  });

  // #505 (#502 follow-up — was the SCOPE BOUNDARY documented-undercount pin):
  // a descriptor-bearing drawing in an EXTRA (2nd+) content-bearing paragraph
  // of a relsUnreadable part is now itemized as its own `unresolvedReference`
  // — in ADDITION to (never instead of) being preserved verbatim inside its
  // raw `extraParagraph` entry. Two image drawings now yield two
  // unresolvedReference entries, so the aggregate part-level warning counts
  // both. The realistic single-image header case (drawing in the first
  // paragraph, test above) is unaffected — this only extends coverage to the
  // discard path.
  it('#505: a descriptor-bearing drawing in an EXTRA paragraph of a relsUnreadable part is ALSO itemized as its own unresolvedReference, alongside the raw extraParagraph entry', () => {
    const firstRId = 'rId9';
    const extraRId = 'rId10';
    const xml = makeHdrXml(
      `${paragraph('', imageDrawingRun(firstRId))}${paragraph('', imageDrawingRun(extraRId))}`
    );
    const result = captureRegion(
      xml,
      'bottom',
      'default',
      'header',
      KNOWN,
      relsUnreadableMedia('word/header1.xml')
    );

    // Both the FIRST paragraph's drawing (base-architecture site) AND the
    // SECOND paragraph's (discard-path, #505) are itemized ...
    const unresolved = result.unmodeled.filter((e) => e.kind === 'unresolvedReference');
    expect(unresolved).toEqual(
      expect.arrayContaining([
        {
          variant: 'default',
          region: 'header',
          kind: 'unresolvedReference',
          detail: { rId: firstRId, part: 'word/header1.xml', reason: RELS_UNREADABLE_REASON },
        },
        {
          variant: 'default',
          region: 'header',
          kind: 'unresolvedReference',
          detail: { rId: extraRId, part: 'word/header1.xml', reason: RELS_UNREADABLE_REASON },
        },
      ])
    );
    expect(unresolved).toHaveLength(2);
    // ... AND the second paragraph is STILL preserved raw — the discard-path
    // itemization adds a companion entry, it never removes the original.
    const extra = result.unmodeled.filter((e) => e.kind === 'extraParagraph');
    expect(extra).toHaveLength(1);
    expect(JSON.stringify(extra[0]?.detail ?? null)).toContain(extraRId);
  });

  // INV-2 asymmetry preserved in the discard path (#505): a drawing with no
  // parseable descriptor (no r:embed / no wp:extent) in an EXTRA paragraph is
  // NOT itemized as unresolvedReference, even against a relsUnreadable part —
  // mirroring header-footer-images.test.ts's own INV-2 pin for the FIRST
  // paragraph's drawing (resolveDrawingImage). The paragraph is still
  // preserved verbatim inside its raw extraParagraph entry either way.
  it('INV-2 (discard path, #505): a descriptor-less drawing in an EXTRA paragraph stays raw extraParagraph only, never unresolvedReference, even against a relsUnreadable part', () => {
    const firstRId = 'rId9';
    const xml = makeHdrXml(
      `${paragraph('', imageDrawingRun(firstRId))}${paragraph('', drawingRun())}`
    );
    const result = captureRegion(
      xml,
      'bottom',
      'default',
      'header',
      KNOWN,
      relsUnreadableMedia('word/header1.xml')
    );

    // Only the FIRST paragraph's (descriptor-bearing) drawing is itemized.
    const unresolved = result.unmodeled.filter((e) => e.kind === 'unresolvedReference');
    expect(unresolved).toEqual([
      {
        variant: 'default',
        region: 'header',
        kind: 'unresolvedReference',
        detail: { rId: firstRId, part: 'word/header1.xml', reason: RELS_UNREADABLE_REASON },
      },
    ]);
    // The descriptor-less drawing's paragraph is still preserved raw, never dropped.
    expect(result.unmodeled.filter((e) => e.kind === 'extraParagraph')).toHaveLength(1);
  });

  // Corpus-safety (#505): the discard-path scanner only activates against a
  // relsUnreadable part — a healthy `resolved` partMedia (and the "no
  // partMedia supplied at all" case) leaves the discard path's behavior
  // exactly as it was before this issue: the extra paragraph's drawing is
  // preserved raw only, never itemized, so an ordinary corpus document with
  // an intact .rels index sees no new unmodeled entries from this change.
  it('corpus-safety (#505): a descriptor-bearing drawing in an EXTRA paragraph of a HEALTHY (resolved) part is never itemized as unresolvedReference', () => {
    const firstRId = 'rId9';
    const extraRId = 'rId10';
    const xml = makeHdrXml(
      `${paragraph('', imageDrawingRun(firstRId))}${paragraph('', imageDrawingRun(extraRId))}`
    );
    const partMedia = resolvedMedia([[firstRId, pngBytes()]]);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN, partMedia);

    expect(result.unmodeled.some((e) => e.kind === 'unresolvedReference')).toBe(false);
    const extra = result.unmodeled.filter((e) => e.kind === 'extraParagraph');
    expect(extra).toHaveLength(1);
    expect(JSON.stringify(extra[0]?.detail ?? null)).toContain(extraRId);
  });

  it('INVARIANT: preserves original run order across text/image/field pieces within a cell — image placement is never reordered', () => {
    const rId = 'rId3';
    const bytes = pngBytes();
    const partMedia = resolvedMedia([[rId, bytes]]);
    const xml = makeHdrXml(
      paragraph(
        '',
        `${textRun('Before ')}${imageDrawingRun(rId)}${textRun(' After ')}${fieldRuns(' PAGE ', '3')}`
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN, partMedia);

    expect(result.region?.left?.content).toEqual([
      { kind: 'literal', text: 'Before ' },
      {
        kind: 'image',
        imageData: Buffer.from(bytes).toString('base64'),
        imageMediaType: 'image/png',
        widthEmu: 914400,
        heightEmu: 609600,
      },
      { kind: 'literal', text: ' After ' },
      { kind: 'pageNumber' },
    ]);
    expect(result.unmodeled).toEqual([]);
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
