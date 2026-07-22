import { describe, it, expect } from 'vitest';
import { parseDocument, extractParagraphText, isParagraphVanish } from './document.js';
import { emptyNumberingMap } from './numbering.js';
import { buildStyleMap } from './styles.js';

function makeDocXml(paragraphs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
}

const EMPTY_STYLES = buildStyleMap(
  `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
);

function makePara(opts: {
  text?: string;
  styleId?: string;
  numId?: number;
  ilvl?: number;
  leftIndent?: number;
  outlineLvl?: number;
  vanish?: boolean;
}): string {
  const numPr =
    opts.numId !== undefined
      ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`
      : '';
  const pStyle = opts.styleId ? `<w:pStyle w:val="${opts.styleId}"/>` : '';
  const ind = opts.leftIndent !== undefined ? `<w:ind w:left="${opts.leftIndent}"/>` : '';
  const outlineLvl =
    opts.outlineLvl !== undefined ? `<w:outlineLvl w:val="${opts.outlineLvl}"/>` : '';
  const vanishRpr = opts.vanish ? '<w:rPr><w:vanish/></w:rPr>' : '';
  const pPr = `<w:pPr>${pStyle}${numPr}${ind}${outlineLvl}${vanishRpr}</w:pPr>`;
  const run = opts.text !== undefined ? `<w:r><w:t>${opts.text}</w:t></w:r>` : '';
  return `<w:p>${pPr}${run}</w:p>`;
}

describe('parseDocument — text extraction', () => {
  it('extracts text from single run', () => {
    const xml = makeDocXml(makePara({ text: 'PART 1 - GENERAL' }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('PART 1 - GENERAL');
  });

  it('concatenates multiple runs', () => {
    const xml = makeDocXml(`<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>`);
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('Hello World');
  });

  it('returns empty text for paragraph with no runs', () => {
    const xml = makeDocXml('<w:p><w:pPr/></w:p>');
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('');
  });

  it('decodes XML entities in text', () => {
    const xml = makeDocXml(`<w:p><w:r><w:t>&lt;Insert text here&gt;</w:t></w:r></w:p>`);
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('<Insert text here>');
  });

  // Regression (#120): Word splits a number like "09 91 26" across runs at
  // edit/rsid boundaries. A run whose text is a bare integer ("9") was coerced
  // to a JS number by fast-xml-parser and dropped — corrupting "09 91 26" → "09 1 26".
  it('preserves a bare-integer run split across a number (#120: numeric run drop)', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t xml:space="preserve">09 </w:t></w:r>` +
        `<w:r><w:t>9</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">1 26</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('09 91 26');
  });

  // Regression: a run <w:tab/> is real whitespace in the rendered text — often the ONLY
  // delimiter in hand-authored outlines ("1.1<tab>SUMMARY", "A.<tab>General"). Dropping it
  // de-spaced the number into the title ("1.1SUMMARY"), defeating every Signal-4 text
  // pattern (all require \s after the number) so the heading fell through to a wrong
  // signal and its outline label never stripped.
  it('preserves a run <w:tab/> as a tab (manual-outline delimiter, not dropped)', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>1.1</w:t></w:r><w:r><w:tab/><w:t>SUMMARY</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('1.1\tSUMMARY');
  });

  // The same drop silently CONCATENATED words split across a tab in body prose
  // ("wireless<tab>signals" → "wirelesssignals") across the DOCX corpus — a content-
  // fidelity loss, not just a hierarchy miss.
  it('does not concatenate words separated by a <w:tab/> (content fidelity)', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>wireless</w:t></w:r><w:r><w:tab/><w:t>signals</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('wireless\tsignals');
  });

  // A pPr > w:tabs > w:tab is a tab-STOP DEFINITION, not content: it must never inject a
  // phantom tab into paragraph text now that a content <w:tab/> renders as whitespace
  // (mirrors merge/extract.ts PROPERTY_TAGS guard).
  it('does NOT inject a phantom tab from a pPr tab-stop definition', () => {
    const xml = makeDocXml(
      `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` +
        `<w:r><w:t>clean</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('clean');
  });
});

describe('parseDocument — pPr field extraction', () => {
  it('extracts styleId', () => {
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1' }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.styleId).toBe('Heading1');
  });

  it('extracts numId and ilvl from own numPr', () => {
    const xml = makeDocXml(makePara({ text: 'text', numId: 3, ilvl: 2 }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.numId).toBe(3);
    expect(result[0]?.ilvl).toBe(2);
  });

  it('extracts leftIndent', () => {
    const xml = makeDocXml(makePara({ text: 'text', leftIndent: 720 }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.leftIndent).toBe(720);
  });

  it('extracts outlineLvl', () => {
    const xml = makeDocXml(makePara({ text: 'text', outlineLvl: 2 }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.outlineLvl).toBe(2);
  });

  it('extracts justification (w:jc) so Signal 5 can ignore a centered indent', () => {
    const xml = makeDocXml(
      `<w:p><w:pPr><w:jc w:val="center"/><w:ind w:left="3859"/></w:pPr>` +
        `<w:r><w:t>SECTION 26 0513.01</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.jc).toBe('center');
    expect(result[0]?.leftIndent).toBe(3859);
  });

  // Codex adversarial review (PR #432): Word commonly stores a title's centering in its
  // paragraph STYLE, not the paragraph. When there is no direct w:jc, resolve the
  // style's basedOn-resolved alignment so Signal 5 still ignores a style-centered title's
  // indent (which would otherwise become a spurious deep-pr node).
  it('resolves style-inherited justification when the paragraph has no direct w:jc', () => {
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:style w:styleId="Title" w:type="paragraph"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>` +
        `</w:styles>`
    );
    const xml = makeDocXml(
      `<w:p><w:pPr><w:pStyle w:val="Title"/><w:ind w:left="3859"/></w:pPr>` +
        `<w:r><w:t>SECTION 26 0513.01</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), styles);
    expect(result[0]?.jc).toBe('center');
  });

  it('prefers a direct w:jc over the paragraph style alignment', () => {
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:style w:styleId="Title" w:type="paragraph"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>` +
        `</w:styles>`
    );
    const xml = makeDocXml(
      `<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="left"/></w:pPr><w:r><w:t>text</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), styles);
    expect(result[0]?.jc).toBe('left');
  });

  it('detects vanish', () => {
    const xml = makeDocXml(makePara({ text: 'hidden', vanish: true }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.isVanish).toBe(true);
  });

  it('returns isVanish false when no vanish element', () => {
    const xml = makeDocXml(makePara({ text: 'visible' }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.isVanish).toBe(false);
  });

  it('detects vanish from all-runs-hidden even without paragraph-mark vanish', () => {
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
    );
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r></w:p>
  </w:body></w:document>`;
    const paras = parseDocument(xml, emptyNumberingMap(), styles);
    expect(paras[0]?.isVanish).toBe(true);
  });

  it('detects vanish inherited from the paragraph style', () => {
    const styles =
      buildStyleMap(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:styleId="Hidden" w:type="paragraph"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`);
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Hidden"/></w:pPr><w:r><w:t>via style</w:t></w:r></w:p>
  </w:body></w:document>`;
    expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(true);
  });

  it('does NOT mark vanish when only some runs are hidden', () => {
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
    );
    // KNOWN AMBIGUITY: a paragraph with a mix of hidden and visible runs is treated
    // as VISIBLE — the visible text is real content; only fully-hidden paragraphs drop out.
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r><w:r><w:t>visible</w:t></w:r></w:p>
  </w:body></w:document>`;
    expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(false);
  });

  it('detects vanish when runs are wrapped in an OOXML container (w:sdt) (Codex #295)', () => {
    // SpecR's own generator wraps runs in w:sdt UUID anchors; a fully-hidden wrapped
    // paragraph must still be detected as hidden, not misread as visible.
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
    );
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:sdt><w:sdtContent><w:r><w:rPr><w:vanish/></w:rPr><w:t>wrapped hidden</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body></w:document>`;
    expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(true);
  });
});

describe('parseDocument — numbering inheritance', () => {
  it('resolves numId/ilvl from style via numberingMap.pStyleToNumId', () => {
    const numMap = {
      ...emptyNumberingMap(),
      pStyleToNumId: new Map([['Heading1', 5]]),
      pStyleToIlvl: new Map([['Heading1', 1]]),
    };
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1' }));
    const result = parseDocument(xml, numMap, EMPTY_STYLES);
    expect(result[0]?.numId).toBe(5);
    expect(result[0]?.ilvl).toBe(1);
  });

  it('own numPr overrides style-inherited numPr', () => {
    const numMap = {
      ...emptyNumberingMap(),
      pStyleToNumId: new Map([['Heading1', 5]]),
      pStyleToIlvl: new Map([['Heading1', 1]]),
    };
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1', numId: 7, ilvl: 3 }));
    const result = parseDocument(xml, numMap, EMPTY_STYLES);
    expect(result[0]?.numId).toBe(7);
    expect(result[0]?.ilvl).toBe(3);
  });

  it('throws ParserError for malformed XML', () => {
    expect(() => parseDocument('<not valid xml', emptyNumberingMap(), EMPTY_STYLES)).toThrow();
  });
});

// #293: extractParagraphText and isParagraphVanish are exported so the DOCX table
// extractor (parses word/document.xml separately, table-scoped) can reuse the exact
// same text/vanish resolution as ordinary paragraphs, instead of re-implementing it.
// These tests pin the exported surface directly against raw fast-xml-parser-shaped
// nodes (mirrors the xml-utils.test.ts convention), independent of the parseDocument
// pipeline above. extractParagraphText collects runs at ANY wrapper depth — the same
// collectRuns traversal isParagraphVanish uses — so text and hiddenness stay symmetric.
describe('extractParagraphText — exported for table extraction reuse (#293)', () => {
  it('extracts text from a direct run', () => {
    expect(extractParagraphText({ 'w:r': [{ 'w:t': 'hello' }] })).toBe('hello');
  });

  it('extracts text from a hyperlink-wrapped run', () => {
    expect(extractParagraphText({ 'w:hyperlink': [{ 'w:r': [{ 'w:t': 'linked' }] }] })).toBe(
      'linked'
    );
  });

  it('returns empty string for a paragraph node with no runs', () => {
    expect(extractParagraphText({})).toBe('');
  });

  // Regression (Codex #293): a run wrapped in a w:sdt content control (SpecR's own
  // round-trip merge anchors) must still be extracted. The narrow direct+hyperlink
  // reader returned '' here, which made classifyTable see no evidence and misclassify a
  // fully-hidden wrapped table as visible — dropping content it is meant to retain.
  it('extracts text from a run nested in a w:sdt content control', () => {
    const raw = { 'w:sdt': { 'w:sdtContent': { 'w:r': [{ 'w:t': 'sdt secret' }] } } };
    expect(extractParagraphText(raw)).toBe('sdt secret');
  });

  it('extracts text from a run nested in a w:ins tracked-change wrapper', () => {
    const raw = { 'w:ins': { 'w:r': [{ 'w:t': 'inserted' }] } };
    expect(extractParagraphText(raw)).toBe('inserted');
  });

  // Symmetry with isParagraphVanish: both must read the SAME wrapped run, so a hidden
  // w:sdt-wrapped cell reports non-empty text AND isVanish=true.
  it('stays symmetric with isParagraphVanish on a hidden w:sdt-wrapped run', () => {
    const raw = { 'w:sdt': { 'w:r': [{ 'w:rPr': { 'w:vanish': '' }, 'w:t': 'hidden sdt' }] } };
    expect(extractParagraphText(raw)).toBe('hidden sdt');
    expect(isParagraphVanish(raw, EMPTY_STYLES)).toBe(true);
  });
});

// ADR-075: a manual page break (`w:br w:type="page"`) found among the runs of a
// paragraph marks the NEXT paragraph as pageBreakBefore=true — the after-the-source
// signal is normalized to a before-the-target flag so it matches docx's own
// Paragraph.pageBreakBefore 1:1 at the generator boundary.
describe('parseDocument — pageBreakBefore (ADR-075)', () => {
  it('sets pageBreakBefore on the paragraph following a manual page break', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>before</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>` +
        `<w:p><w:r><w:t>after</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.pageBreakBefore).toBeUndefined();
    expect(result[1]?.pageBreakBefore).toBe(true);
  });

  // A page break with no following paragraph (trailing/EOF) has nothing to attach
  // the flag to and is silently dropped — a documented scoping limit (ADR-075), not
  // a bug: parsing must still succeed and produce no spurious flag anywhere.
  it('drops a trailing page break with no following paragraph (KNOWN AMBIGUITY)', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>first</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>last</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result).toHaveLength(2);
    expect(result[0]?.pageBreakBefore).toBeUndefined();
    expect(result[1]?.pageBreakBefore).toBeUndefined();
  });

  // A bare <w:br/> with no w:type attribute is an ordinary line break, not a page
  // break — must not set the flag.
  it('does not set pageBreakBefore for a bare line break (<w:br/> with no w:type)', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>line one</w:t></w:r><w:r><w:br/></w:r></w:p>` +
        `<w:p><w:r><w:t>line two</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[1]?.pageBreakBefore).toBeUndefined();
  });

  // w:type="column" is a column break, a different OOXML break kind — must not be
  // misread as a page break.
  it('does not set pageBreakBefore for a column break (w:type="column")', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>col one</w:t></w:r><w:r><w:br w:type="column"/></w:r></w:p>` +
        `<w:p><w:r><w:t>col two</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[1]?.pageBreakBefore).toBeUndefined();
  });

  // Two-or-more page breaks in a single paragraph collapse to a single true — the
  // parser has no richer positional model (documented KNOWN AMBIGUITY, ADR-075).
  it('collapses 2+ page breaks in one paragraph to a single true', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>text</w:t></w:r>` +
        `<w:r><w:br w:type="page"/></w:r><w:r><w:br w:type="page"/></w:r></w:p>` +
        `<w:p><w:r><w:t>after</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[1]?.pageBreakBefore).toBe(true);
  });

  // #497 review finding: runHasPageBreak's own comment (ADR-075) names 3 verified
  // parse shapes for run['w:br'] — object, empty string '', and ARRAY (2+ sibling
  // w:br in the SAME w:r) — but no fixture before this one ever produced the array
  // shape: the "collapses 2+ page breaks" test above uses two SEPARATE <w:r>
  // elements, each contributing a single-object run['w:br']. Verified directly
  // against createDocumentXmlParser: <w:r><w:br .../><w:br .../></w:r> parses
  // run['w:br'] to an array of two objects, a materially different shape that
  // toArray<unknown> must still walk. Pins the array-detection path so it cannot
  // silently regress (e.g. a "simplification" to a direct single-value read).
  it('detects a page break when 2+ sibling <w:br> live in the SAME <w:r> (array shape)', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>text</w:t></w:r>` +
        `<w:r><w:br w:type="page"/><w:br w:type="page"/></w:r></w:p>` +
        `<w:p><w:r><w:t>after</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[1]?.pageBreakBefore).toBe(true);
  });

  // A w:br sandwiched between two w:t runs inside the SAME w:r must still be
  // detected — no special-casing on run position within the paragraph.
  it('detects a page break sandwiched between two w:t runs in the same w:r', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t>foo</w:t><w:br w:type="page"/><w:t>bar</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>after</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[1]?.pageBreakBefore).toBe(true);
  });

  // #497 review finding: a source Word doc can carry a manual page break as a
  // paragraph-level `w:pageBreakBefore` property (Paragraph dialog / heading
  // style), not only as a run-level w:br in the preceding paragraph, so the
  // parser must ALSO read a paragraph's own property. Detected ON the paragraph
  // itself, not shifted from a predecessor.
  it('sets pageBreakBefore from a paragraph OWN w:pageBreakBefore property (Word "Page break before")', () => {
    const xml = makeDocXml(
      `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>starts new page</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.pageBreakBefore).toBe(true);
  });

  // CT_OnOff toggle: an explicit falsey w:val (e.g. a style disabling an
  // inherited break) means the property is OFF, not on.
  it('does not set pageBreakBefore for an own w:pageBreakBefore explicitly disabled (w:val="false")', () => {
    const xml = makeDocXml(
      `<w:p><w:pPr><w:pageBreakBefore w:val="false"/></w:pPr><w:r><w:t>no break</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.pageBreakBefore).toBeUndefined();
  });
});

describe('isParagraphVanish — exported for table extraction reuse (#293)', () => {
  it('detects vanish from the paragraph mark (w:pPr > w:rPr > w:vanish)', () => {
    const raw = { 'w:pPr': { 'w:rPr': { 'w:vanish': '' } }, 'w:r': [{ 'w:t': 'hidden mark' }] };
    expect(isParagraphVanish(raw, EMPTY_STYLES)).toBe(true);
  });

  it('returns false for a visible paragraph with no vanish signal', () => {
    const raw = { 'w:pPr': {}, 'w:r': [{ 'w:t': 'visible' }] };
    expect(isParagraphVanish(raw, EMPTY_STYLES)).toBe(false);
  });

  // Pins the reuse decision (design decision #4): table-cell paragraph hiddenness
  // consults the FULL 3-signal resolveParagraphVanish, including paragraph-STYLE
  // vanish, not just a run-level check — a cell paragraph using a "Hidden" style
  // with no run-level w:vanish is still classified as vanish.
  it('detects vanish inherited from the paragraph style, with no run-level w:vanish', () => {
    const styles =
      buildStyleMap(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:styleId="Hidden" w:type="paragraph"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`);
    const raw = {
      'w:pPr': { 'w:pStyle': { '@_w:val': 'Hidden' } },
      'w:r': [{ 'w:t': 'via style' }],
    };
    expect(isParagraphVanish(raw, styles)).toBe(true);
  });

  it('detects vanish when all text runs carry a run-level w:vanish (no paragraph-mark or style vanish)', () => {
    const raw = { 'w:pPr': {}, 'w:r': [{ 'w:rPr': { 'w:vanish': '' }, 'w:t': 'hidden run' }] };
    expect(isParagraphVanish(raw, EMPTY_STYLES)).toBe(true);
  });

  it('detects vanish for a run wrapped in a hyperlink', () => {
    const raw = {
      'w:pPr': {},
      'w:hyperlink': [{ 'w:r': [{ 'w:rPr': { 'w:vanish': '' }, 'w:t': 'hidden link' }] }],
    };
    expect(isParagraphVanish(raw, EMPTY_STYLES)).toBe(true);
  });
});
