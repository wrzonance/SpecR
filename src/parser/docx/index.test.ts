import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseDocx } from './index.js';
import { parse } from '../index.js';
import type { SpecNode } from '../../ast/types.js';

const MINIMAL_STYLES = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

const MINIMAL_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Plain paragraph text.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const STRUCTURED_NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="multilevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="PART %1"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2"/></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%3."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const STRUCTURED_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Includes work.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Continuation paragraph text here.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

async function makeDocx(opts: {
  documentXml?: string;
  stylesXml?: string;
  numberingXml?: string;
  commentsXml?: string;
  coreXml?: string;
  omitDocument?: boolean;
  omitStyles?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  if (!opts.omitStyles) zip.file('word/styles.xml', opts.stylesXml ?? MINIMAL_STYLES);
  if (!opts.omitDocument) zip.file('word/document.xml', opts.documentXml ?? MINIMAL_DOC);
  if (opts.numberingXml) zip.file('word/numbering.xml', opts.numberingXml);
  if (opts.commentsXml) zip.file('word/comments.xml', opts.commentsXml);
  if (opts.coreXml) zip.file('docProps/core.xml', opts.coreXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const ARCAT_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="ARCATArticle" w:type="paragraph">
    <w:name w:val="ARCATArticle"/>
    <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
  </w:style>
</w:styles>`;

const CORE_XML = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:subject>27 21 00</dc:subject>
  <dc:title>Structured Cabling</dc:title>
</cp:coreProperties>`;

function flatTypes(nodes: readonly SpecNode[]): string[] {
  return [...nodes.flatMap((n) => [n.type, ...flatTypes(n.children)])];
}

interface CommentFact {
  readonly author: string;
  readonly text: string;
  readonly anchor: readonly [number, number];
  readonly closed: boolean;
}

interface ColorFact {
  readonly color: string;
  readonly coverage: number;
  readonly spans: readonly (readonly [number, number])[];
}

interface ChoiceTokenFact {
  readonly kind: 'angle' | 'bracket';
  readonly options: readonly string[];
  readonly span: readonly [number, number];
}

interface TestSourceFacts {
  readonly comments?: readonly CommentFact[];
  readonly colors?: readonly ColorFact[];
  readonly choiceTokens?: readonly ChoiceTokenFact[];
}

function allNodes(nodes: readonly SpecNode[]): readonly SpecNode[] {
  return nodes.flatMap((n) => [n, ...allNodes(n.children)]);
}

function sourceFacts(node: SpecNode | undefined): TestSourceFacts | undefined {
  const meta = node?.meta as { readonly sourceFacts?: TestSourceFacts };
  return meta.sourceFacts;
}

function sourceComments(node: SpecNode | undefined): readonly CommentFact[] | undefined {
  return sourceFacts(node)?.comments;
}

function sourceColors(node: SpecNode | undefined): readonly ColorFact[] | undefined {
  return sourceFacts(node)?.colors;
}

function sourceChoiceTokens(node: SpecNode | undefined): readonly ChoiceTokenFact[] | undefined {
  return sourceFacts(node)?.choiceTokens;
}

function findNode(nodes: readonly SpecNode[], text: string): SpecNode | undefined {
  return allNodes(nodes).find((n) => n.text === text);
}

describe('parseDocx — happy path', () => {
  it('parses minimal DOCX without numbering', async () => {
    const buffer = await makeDocx({});
    const tree = await parseDocx(buffer);
    expect(tree.parts.length).toBeGreaterThan(0);
  });

  it('parses structured DOCX with numbering — produces part/article/pr1/continuation', async () => {
    const buffer = await makeDocx({
      numberingXml: STRUCTURED_NUMBERING,
      documentXml: STRUCTURED_DOC,
    });
    const tree = await parseDocx(buffer);
    const types = flatTypes(tree.parts);
    expect(types).toContain('part');
    expect(types).toContain('article');
    expect(types).toContain('pr1');
    expect(types).toContain('continuation');
    // source='unknown' — synthetic styles.xml has no source-identifying style names
    expect(tree.parts[0]?.meta.source).toBe('unknown');
  });

  it('calls onProgress at each stage', async () => {
    const stages: string[] = [];
    const buffer = await makeDocx({});
    await parseDocx(buffer, (stage) => stages.push(stage));
    expect(stages).toEqual([
      'extracting',
      'numbering',
      'styles',
      'document',
      'classifying',
      'complete',
    ]);
  });

  // Flatten a tree to every node (depth-first) — used to assert hidden retention.
  const allNodes = (nodes: readonly SpecNode[]): SpecNode[] =>
    nodes.flatMap((n) => [n, ...allNodes(n.children)]);

  it('hidden preamble does not pollute the root yet is retained (no-reserved-levels path)', async () => {
    const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>SPECIFICATION PROCESSING FORM</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
  </w:body></w:document>`;
    const tree = await parseDocx(
      await makeDocx({ documentXml: doc, numberingXml: STRUCTURED_NUMBERING })
    );
    // The hidden form is excluded from structural inference …
    expect((tree.warnings ?? []).some((w) => w.type === 'root-continuation')).toBe(false);
    expect(tree.parts.filter((n) => n.type === 'part')).toHaveLength(1);
    // … but RETAINED in the tree (would fail if vanished paragraphs were dropped).
    const hidden = allNodes(tree.parts).find((n) =>
      n.text.includes('SPECIFICATION PROCESSING FORM')
    );
    expect(hidden?.meta.vanish).toBe(true);
  });

  it('hidden preamble excluded + retained on the reserved-low-level path (ilvl offset)', async () => {
    // Reserved-low-level DOCX: PRT/ART styles, Article reserved at ilvl=3 (Schedule/PDS at 1–2).
    const cpiStyles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="PRT" w:type="paragraph"><w:name w:val="PRT"/></w:style>
      <w:style w:styleId="ART" w:type="paragraph"><w:name w:val="ART"/><w:pPr><w:numPr><w:ilvl w:val="3"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    </w:styles>`;
    const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>PROJECT SPEC SIGN-OFF</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="PRT"/></w:pPr><w:r><w:t>PART 1 - GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ART"/><w:numPr><w:ilvl w:val="3"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
  </w:body></w:document>`;
    const tree = await parseDocx(
      await makeDocx({ documentXml: doc, stylesXml: cpiStyles, numberingXml: STRUCTURED_NUMBERING })
    );
    expect((tree.warnings ?? []).some((w) => w.type === 'root-continuation')).toBe(false);
    expect(tree.parts.filter((n) => n.type === 'part')).toHaveLength(1);
    const hidden = allNodes(tree.parts).find((n) => n.text.includes('PROJECT SPEC SIGN-OFF'));
    expect(hidden?.meta.vanish).toBe(true);
  });

  it('reserved-low-level PRT+ART synthetic: tags source=cpi and derives SUMMARY role=summary', async () => {
    // Committed synthetic standing in for the copyrighted CPI v2 fixtures (#321):
    // PRT/ART short-form styles are the CPI style fingerprint, and the Article tier
    // is reserved at ilvl=3 (Schedule/PDS occupy ilvl 1–2). This pins the REAL
    // invariant in CI without a fixture — (1) detectSource tags PRT+ART as 'cpi';
    // (2) the reserved-ilvl offset is normalized into node_type='article' so a
    // standard heading (SUMMARY) still derives its CSI role.
    const cpiStyles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="PRT" w:type="paragraph"><w:name w:val="PRT"/></w:style>
      <w:style w:styleId="ART" w:type="paragraph"><w:name w:val="ART"/><w:pPr><w:numPr><w:ilvl w:val="3"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    </w:styles>`;
    const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="PRT"/></w:pPr><w:r><w:t>PART 1 - GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ART"/><w:numPr><w:ilvl w:val="3"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
  </w:body></w:document>`;
    const buffer = await makeDocx({
      documentXml: doc,
      stylesXml: cpiStyles,
      numberingXml: STRUCTURED_NUMBERING,
    });

    // meta.source is set by detectSource in the parseDocx pipeline — safe to read here.
    const tree = await parseDocx(buffer);
    expect(allNodes(tree.parts).every((n) => n.meta.source === 'cpi')).toBe(true);

    // GOTCHA: articleRole is tagged in parse() (parser/index.ts), NOT parseDocx —
    // route this assertion through parse() or articleRole reads undefined.
    const { tree: parsed } = await parse(buffer, 'cpi-v2-synthetic.docx');
    const summary = allNodes(parsed.parts).find(
      (n) => n.type === 'article' && n.text === 'SUMMARY'
    );
    expect(summary?.meta.articleRole).toBe('summary');
  });
});

describe('parseDocx — error handling', () => {
  it('throws ParserError for corrupt buffer', async () => {
    await expect(parseDocx(Buffer.from('not a zip'))).rejects.toThrow(
      'failed to read DOCX archive'
    );
  });

  it('throws ParserError with DOCX_ARCHIVE_UNREADABLE code on a non-zip buffer', async () => {
    await expect(parseDocx(Buffer.from('not a zip'), () => {})).rejects.toMatchObject({
      name: 'ParserError',
      code: 'DOCX_ARCHIVE_UNREADABLE',
    });
  });

  it('throws ParserError when word/styles.xml missing', async () => {
    const buffer = await makeDocx({ omitStyles: true });
    await expect(parseDocx(buffer)).rejects.toThrow('DOCX missing word/styles.xml');
  });

  it('throws ParserError when word/document.xml missing', async () => {
    const buffer = await makeDocx({ omitDocument: true });
    await expect(parseDocx(buffer)).rejects.toThrow('DOCX missing word/document.xml');
  });

  it('throws ParserError for document with no w:p elements', async () => {
    // A body with only w:sectPr (no paragraphs) → parseDocument returns [] → throws
    const noParagraphsDoc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sectPr/></w:body></w:document>`;
    const buffer = await makeDocx({ documentXml: noParagraphsDoc });
    await expect(parseDocx(buffer)).rejects.toThrow('document contains no paragraphs');
  });

  it('detects source=arcat from the source-identifying style-name prefix', async () => {
    const buffer = await makeDocx({ stylesXml: ARCAT_STYLES });
    const tree = await parseDocx(buffer);
    expect(tree.parts[0]?.meta.source).toBe('arcat');
  });

  it('extracts section/title from docProps/core.xml when present', async () => {
    const zip = new JSZip();
    zip.file('word/styles.xml', MINIMAL_STYLES);
    zip.file('word/document.xml', MINIMAL_DOC);
    zip.file('docProps/core.xml', CORE_XML);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('27 21 00');
    expect(tree.title).toBe('Structured Cabling');
  });

  it('uses unknown for section/title when docProps absent', async () => {
    const buffer = await makeDocx({});
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('unknown');
    expect(tree.title).toBe('unknown');
  });

  it('emits core-metadata-unreadable warning when docProps/core.xml is malformed', async () => {
    // Otherwise-valid docx (default MINIMAL_DOC/MINIMAL_STYLES) — only core.xml is broken.
    const buffer = await makeDocx({ coreXml: '<<<not xml' });
    const tree = await parseDocx(buffer);
    expect(tree.warnings?.some((w) => w.type === 'core-metadata-unreadable')).toBe(true);
    expect(tree.section).toBe('unknown');
    expect(tree.title).toBe('unknown');
  });
});

describe('parseDocx — source facts: comments (#128)', () => {
  const commentsXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="0" w:author="Jane Specifier">
    <w:p><w:r><w:t>Use approved product list.</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="1" w:author="Alex Reviewer">
    <w:p><w:r><w:t>Coordinate with owner.</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="2" w:author="Jane Specifier">
    <w:p><w:r><w:t>Spans paragraphs.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

  it('attaches two comments on different paragraphs exactly', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Alpha </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>target</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t> one.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Beta </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>target</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t> two.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    const tree = await parseDocx(await makeDocx({ documentXml, commentsXml }));
    const first = findNode(tree.parts, 'Alpha target one.');
    const second = findNode(tree.parts, 'Beta target two.');

    expect(sourceComments(first)).toEqual([
      {
        author: 'Jane Specifier',
        text: 'Use approved product list.',
        anchor: [6, 12],
        closed: false,
      },
    ]);
    expect(sourceComments(second)).toEqual([
      { author: 'Alex Reviewer', text: 'Coordinate with owner.', anchor: [5, 11], closed: false },
    ]);
  });

  it('keeps comment facts aligned when the document contains an empty paragraph', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Alpha text.</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:t>Beta </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>target</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t> text.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    const tree = await parseDocx(await makeDocx({ documentXml, commentsXml }));
    const alpha = findNode(tree.parts, 'Alpha text.');
    const beta = findNode(tree.parts, 'Beta target text.');

    expect(sourceComments(alpha)).toBeUndefined();
    expect(sourceComments(beta)).toEqual([
      { author: 'Alex Reviewer', text: 'Coordinate with owner.', anchor: [5, 11], closed: false },
    ]);
  });

  it('clips a spanning comment to each covered paragraph anchor', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Alpha </w:t></w:r><w:commentRangeStart w:id="2"/><w:r><w:t>covered</w:t></w:r></w:p>
    <w:p><w:r><w:t>Beta</w:t></w:r><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r><w:r><w:t> tail</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    const tree = await parseDocx(await makeDocx({ documentXml, commentsXml }));
    const first = findNode(tree.parts, 'Alpha covered');
    const second = findNode(tree.parts, 'Beta tail');

    // Spanning comments are represented as one fact per covered paragraph,
    // clipped to each paragraph's local flattened text span.
    expect(sourceComments(first)).toEqual([
      { author: 'Jane Specifier', text: 'Spans paragraphs.', anchor: [6, 13], closed: false },
    ]);
    expect(sourceComments(second)).toEqual([
      { author: 'Jane Specifier', text: 'Spans paragraphs.', anchor: [0, 4], closed: false },
    ]);
  });

  it('omits sourceFacts when comments.xml is absent', async () => {
    const tree = await parseDocx(await makeDocx({ documentXml: MINIMAL_DOC }));
    expect(allNodes(tree.parts).every((n) => sourceComments(n) === undefined)).toBe(true);
  });

  it('malformed comments.xml throws ParserError instead of silently dropping comments', async () => {
    const buffer = await makeDocx({ commentsXml: '<w:comments><w:comment' });
    await expect(parseDocx(buffer)).rejects.toThrow('failed to parse word/comments.xml');
  });

  it('marks closed=true for a struck-through comment and a "Closed"-suffixed comment (#262)', async () => {
    const closureComments = `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="0" w:author="Jane Specifier">
    <w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>Resolved upstream.</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="1" w:author="Alex Reviewer">
    <w:p><w:r><w:t>Coordinate with owner. Closed</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="2" w:author="Pat Author">
    <w:p><w:r><w:t>Still open question.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Struck </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>target</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
    <w:p><w:r><w:t>Suffix </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>target</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>
    <w:p><w:r><w:t>Open </w:t></w:r><w:commentRangeStart w:id="2"/><w:r><w:t>target</w:t></w:r><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r></w:p>
  </w:body>
</w:document>`;
    const tree = await parseDocx(await makeDocx({ documentXml, commentsXml: closureComments }));
    const struck = sourceComments(findNode(tree.parts, 'Struck target'))?.[0];
    const suffix = sourceComments(findNode(tree.parts, 'Suffix target'))?.[0];
    const open = sourceComments(findNode(tree.parts, 'Open target'))?.[0];

    expect(struck?.closed).toBe(true);
    expect(suffix?.closed).toBe(true);
    expect(open?.closed).toBe(false);
  });
});

describe('parseDocx — source facts: run colors (#129)', () => {
  function colorRun(color: string, text: string): string {
    return `<w:r><w:rPr><w:color w:val="${color}"/></w:rPr><w:t>${text}</w:t></w:r>`;
  }

  function highlightRun(highlight: string, text: string): string {
    return `<w:r><w:rPr><w:highlight w:val="${highlight}"/></w:rPr><w:t>${text}</w:t></w:r>`;
  }

  function colorDoc(paragraphs: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs}</w:body>
</w:document>`;
  }

  it('records a blue phrase with exact span and coverage', async () => {
    const documentXml = colorDoc(
      `<w:p><w:r><w:t>Alpha </w:t></w:r>${colorRun('0000FF', 'blue')}<w:r><w:t> end</w:t></w:r></w:p>`
    );
    const tree = await parseDocx(await makeDocx({ documentXml }));
    const node = findNode(tree.parts, 'Alpha blue end');
    const colors = sourceColors(node);

    expect(colors).toHaveLength(1);
    expect(colors?.[0]?.color).toBe('0000FF');
    expect(colors?.[0]?.spans).toEqual([[6, 10]]);
    expect(colors?.[0]?.coverage).toBeCloseTo(4 / 14);
  });

  it('records a fully blue paragraph with coverage 1.0', async () => {
    const documentXml = colorDoc(`<w:p>${colorRun('0000FF', 'Fully blue.')}</w:p>`);
    const tree = await parseDocx(await makeDocx({ documentXml }));
    const colors = sourceColors(findNode(tree.parts, 'Fully blue.'));

    expect(colors).toEqual([{ color: '0000FF', coverage: 1, spans: [[0, 11]] }]);
  });

  it('omits black and auto-only run colors', async () => {
    const documentXml = colorDoc(
      `<w:p>${colorRun('000000', 'Black text.')}</w:p><w:p>${colorRun('auto', 'Auto text.')}</w:p>`
    );
    const tree = await parseDocx(await makeDocx({ documentXml }));

    expect(sourceColors(findNode(tree.parts, 'Black text.'))).toBeUndefined();
    expect(sourceColors(findNode(tree.parts, 'Auto text.'))).toBeUndefined();
  });

  it('records one source fact per distinct run color', async () => {
    const documentXml = colorDoc(
      `<w:p>${colorRun('FF0000', 'Red')}<w:r><w:t> </w:t></w:r>${colorRun('0000FF', 'Blue')}</w:p>`
    );
    const tree = await parseDocx(await makeDocx({ documentXml }));
    const colors = sourceColors(findNode(tree.parts, 'Red Blue'));

    expect(colors).toEqual([
      { color: 'FF0000', coverage: 3 / 8, spans: [[0, 3]] },
      { color: '0000FF', coverage: 4 / 8, spans: [[4, 8]] },
    ]);
  });

  it('records highlight as a highlight-prefixed color fact', async () => {
    const documentXml = colorDoc(
      `<w:p><w:r><w:t>Use </w:t></w:r>${highlightRun('yellow', 'highlight')}<w:r><w:t>.</w:t></w:r></w:p>`
    );
    const tree = await parseDocx(await makeDocx({ documentXml }));
    const colors = sourceColors(findNode(tree.parts, 'Use highlight.'));

    expect(colors).toEqual([{ color: 'highlight:yellow', coverage: 9 / 14, spans: [[4, 13]] }]);
  });
});

describe('parseDocx — source facts: choice tokens (#130)', () => {
  function choiceDoc(text: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`;
  }

  async function parseChoiceNode(
    xmlText: string,
    parsedText = xmlText
  ): Promise<SpecNode | undefined> {
    const tree = await parseDocx(await makeDocx({ documentXml: choiceDoc(xmlText) }));
    return findNode(tree.parts, parsedText);
  }

  it('groups adjacent angle options into one pick-one candidate', async () => {
    const node = await parseChoiceNode('&lt;aluminum&gt;&lt;steel&gt;', '<aluminum><steel>');
    expect(sourceChoiceTokens(node)).toEqual([
      { kind: 'angle', options: ['aluminum', 'steel'], span: [0, 17] },
    ]);
  });

  it('ignores a lone angle segment because angle choices require adjacent options', async () => {
    const node = await parseChoiceNode('&lt;aluminum&gt;', '<aluminum>');
    expect(sourceChoiceTokens(node)).toBeUndefined();
  });

  it('groups adjacent bracket options into one pick-one candidate', async () => {
    const node = await parseChoiceNode('[red][blue]');
    expect(sourceChoiceTokens(node)).toEqual([
      { kind: 'bracket', options: ['red', 'blue'], span: [0, 11] },
    ]);
  });

  it('records a lone bracketed segment as a single-option keep-delete candidate', async () => {
    const node = await parseChoiceNode('[Provide mockup.]');
    expect(sourceChoiceTokens(node)).toEqual([
      { kind: 'bracket', options: ['Provide mockup.'], span: [0, 17] },
    ]);
  });

  it('ignores unclosed delimiters without error', async () => {
    const node = await parseChoiceNode('Use [unclosed option here.');
    expect(sourceChoiceTokens(node)).toBeUndefined();
  });

  it('skips nested brackets as ambiguous', async () => {
    // KNOWN AMBIGUITY: nested brackets can be tailoring choices or literal bracketed text.
    const node = await parseChoiceNode('[outer [inner]]');
    expect(sourceChoiceTokens(node)).toBeUndefined();
  });

  it('skips nested adjacent brackets without emitting an inner candidate', async () => {
    // KNOWN AMBIGUITY: adjacent nested brackets can be tailoring choices or literal text.
    const node = await parseChoiceNode('[[a][b]]');
    expect(sourceChoiceTokens(node)).toBeUndefined();
  });

  it('skips section-reference-like brackets as ambiguous', async () => {
    // KNOWN AMBIGUITY: [Section 09 91 26] looks like a CSI cross-reference, not a choice.
    const node = await parseChoiceNode('[Section 09 91 26]');
    expect(sourceChoiceTokens(node)).toBeUndefined();
  });
});

describe('parseDocx — dc:subject section normalization (#gate)', () => {
  function coreWith(subject: string): string {
    return `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:subject>${subject}</dc:subject>
  <dc:title>Structured Cabling</dc:title>
</cp:coreProperties>`;
  }

  it('degrades free-text dc:subject to unknown (does not leak prose as section)', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('Division 26 - Electrical') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('unknown');
  });

  it('keeps a conforming dc:subject section number', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('26 00 13.10') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('26 00 13.10');
  });

  it('normalizes a dirty (multi-space) dc:subject section number', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('26  00 13.10') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('26 00 13.10');
  });

  it('normalizes a display-variant dc:subject section number', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('09.91.00') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('09 91 00');
  });
});

// ── Realistic end-to-end: numbering-generated PART prefixes, style-only
//    part linkage (reverse pStyle), preamble, specifier notes, no core.xml ──

const ARCAT_E2E_NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:pStyle w:val="ARCATPart"/><w:lvlText w:val="PART  %1"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:pStyle w:val="ARCATArticle"/><w:lvlText w:val="%1.%2"/></w:lvl>
    <w:lvl w:ilvl="2"><w:numFmt w:val="upperLetter"/><w:pStyle w:val="ARCATParagraph"/><w:lvlText w:val="%3."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const ARCAT_E2E_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="ARCATPart" w:type="paragraph"><w:name w:val="ARCATPart"/></w:style>
  <w:style w:styleId="ARCATArticle" w:type="paragraph">
    <w:name w:val="ARCATArticle"/>
    <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
  </w:style>
  <w:style w:styleId="ARCATParagraph" w:type="paragraph">
    <w:name w:val="ARCATParagraph"/>
    <w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr></w:pPr>
  </w:style>
  <w:style w:styleId="ARCATnote" w:type="paragraph"><w:name w:val="ARCATnote"/></w:style>
  <w:style w:styleId="ARCATTitle" w:type="paragraph"><w:name w:val="ARCATTitle"/></w:style>
</w:styles>`;

function p(style: string | null, text: string): string {
  const pr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

const ARCAT_E2E_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${p('ARCATTitle', 'SECTION 21 11 00')}
    ${p('ARCATTitle', 'FIRE SPRINKLER FITTINGS AND VALVES')}
    ${p('ARCATTitle', 'Copyright 2018 - 2019 ARCAT, Inc. - All rights reserved')}
    ${p('ARCATnote', '** NOTE TO SPECIFIER ** AGF Manufacturing; delete options not required.')}
    ${p('ARCATPart', 'GENERAL')}
    ${p('ARCATArticle', 'SECTION INCLUDES')}
    ${p('ARCATParagraph', 'Fire sprinkler fittings and valves.')}
    ${p('ARCATPart', 'PRODUCTS')}
    ${p('ARCATArticle', 'MANUFACTURERS')}
    ${p('ARCATPart', 'EXECUTION')}
    ${p('ARCATArticle', 'INSTALLATION')}
  </w:body>
</w:document>`;

describe('parseDocx — realistic regression (numbering-generated PART prefixes yielded 34 parts instead of 3)', () => {
  async function parseArcatE2e() {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC,
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
    });
    return parseDocx(buffer);
  }

  it('classifies numbering-generated PART headings: exactly 3 part-type roots', async () => {
    const tree = await parseArcatE2e();
    const partRoots = tree.parts.filter((n) => n.type === 'part');
    expect(partRoots.map((n) => n.text)).toEqual(['GENERAL', 'PRODUCTS', 'EXECUTION']);
  });

  it('articles nest under their parts, not as roots', async () => {
    const tree = await parseArcatE2e();
    const general = tree.parts.find((n) => n.text === 'GENERAL');
    expect(
      general?.children.some((c) => c.type === 'article' && c.text === 'SECTION INCLUDES')
    ).toBe(true);
  });

  it('parse() orchestrator infers section/title from content when core.xml is absent', async () => {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC,
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
    });
    const result = await parse(buffer, 'arcat-e2e.docx');
    expect(result.sectionInference.method).toBe('content-high');
    expect(result.tree.section).toBe('21 11 00');
    expect(result.tree.title).toBe('FIRE SPRINKLER FITTINGS AND VALVES');
  });

  it('parse() orchestrator normalizes compact SECTION display from DOCX content', async () => {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC.replace('SECTION 21 11 00', 'SECTION 099100 - PAINTING'),
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
    });
    const result = await parse(buffer, 'arcat-e2e.docx');
    expect(result.sectionInference.method).toBe('content-high');
    expect(result.tree.section).toBe('09 91 00');
    expect(result.tree.title).toBe('PAINTING');
  });

  it('parseDocx alone leaves section unknown — inference belongs to the orchestrator', async () => {
    const tree = await parseArcatE2e();
    expect(tree.section).toBe('unknown');
  });

  it('specifier-note banner becomes a vanish note, not a bare continuation', async () => {
    const tree = await parseArcatE2e();
    const all = (ns: readonly SpecNode[]): SpecNode[] => [
      ...ns,
      ...ns.flatMap((n) => all(n.children)),
    ];
    const note = all(tree.parts).find((n) => n.text.startsWith('** NOTE TO SPECIFIER **'));
    expect(note?.type).toBe('note');
    expect(note?.meta.vanish).toBe(true);
  });

  it('emits root-continuation warning for preamble junk roots, but no unusual-part-count', async () => {
    const tree = await parseArcatE2e();
    const types = (tree.warnings ?? []).map((w) => w.type);
    expect(types).toContain('root-continuation');
    expect(types).not.toContain('unusual-part-count');
    expect(types).not.toContain('no-structure-found');
  });

  it('core.xml metadata still wins over content inference when present', async () => {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC,
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
      coreXml: CORE_XML,
    });
    const result = await parse(buffer, 'arcat-e2e.docx');
    expect(result.sectionInference.method).toBe('metadata');
    expect(result.tree.section).toBe('27 21 00');
    expect(result.tree.title).toBe('Structured Cabling');
  });
});

// ── Non-pStyle-linked PART regression: PART headings anchored on numbering that is NOT
//    pStyle-linked. The ilvl=0 lvlText "PART %1 -" generates the prefix, so the
//    paragraph text is the bare canonical name. Before the fix the Signal-1 guard
//    demoted GENERAL/PRODUCTS to continuation and only 1 part survived. ──

// numId 1 → abstractNum 5: the PART ladder (ilvl=0 lvlText "PART %1 -", 0 pStyle
// links). numId 2 → abstractNum 0: a generic outline ("%1", NOT part-shaped) — the
// artifact uses it for EMPTY PART anchors that must drop, not become spurious parts.
const CPI_PART_NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="5">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="PART %1 -"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="5"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

function numbered(ilvl: number, text: string, numId = 1): string {
  return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

// Mirrors the real hand-authored pathology: bare-name PART headings on the
// "PART %1 -" ladder, plus an EMPTY anchor on the generic numId 2 that must drop.
const CPI_PART_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${numbered(0, 'GENERAL')}
    ${numbered(1, 'SUMMARY')}
    ${numbered(0, 'PRODUCTS')}
    ${numbered(0, '', 2)}
    ${numbered(1, 'MANUFACTURERS')}
    ${numbered(0, 'EXECUTION')}
    ${numbered(1, 'INSTALLATION')}
  </w:body>
</w:document>`;

// ── End-to-end asterisk-rule note region (#292): PART heading, a paired rule-row
//    delimiter enclosing prose, then ordinary trailing content — through the full
//    parseDocx pipeline (extract → numbering → styles → document → classify → tree),
//    not just the classifyParagraphs/buildTree unit boundary (inference-notes.test.ts). ──

const RULE_ROW_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:r><w:t>*****</w:t></w:r></w:p>
    <w:p><w:r><w:t>Delete items below not applicable to this project.</w:t></w:r></w:p>
    <w:p><w:r><w:t>*****</w:t></w:r></w:p>
    <w:p><w:r><w:t>Ordinary body text after the region closes.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

describe('parseDocx — end-to-end asterisk-rule note region (#292)', () => {
  it('no rule-row text survives anywhere in the tree; enclosed prose is note; trailing content resumes as continuation', async () => {
    const buffer = await makeDocx({
      documentXml: RULE_ROW_DOC,
      numberingXml: STRUCTURED_NUMBERING,
    });
    const tree = await parseDocx(buffer);

    // Invariant: no node's full trimmed text anywhere in the tree is a bare
    // 5-or-more-asterisk run — rule rows produce no SpecNode at all.
    const ruleRowSurvivors = allNodes(tree.parts).filter((n) => /^\*{5,}$/.test(n.text.trim()));
    expect(ruleRowSurvivors).toEqual([]);

    const general = tree.parts.find((n) => n.type === 'part' && n.text === 'GENERAL');
    expect(general).toBeDefined();
    const children = general?.children ?? [];
    expect(children).toHaveLength(2);

    const note = children.find(
      (n) => n.text === 'Delete items below not applicable to this project.'
    );
    expect(note?.type).toBe('note');

    const trailing = children.find((n) => n.text === 'Ordinary body text after the region closes.');
    expect(trailing?.type).toBe('continuation');
  });
});

describe('parseDocx — numbering-lvlText PART inference (lvlText "PART %1 -", 0 pStyle links)', () => {
  async function parseCpi() {
    const buffer = await makeDocx({
      documentXml: CPI_PART_DOC,
      numberingXml: CPI_PART_NUMBERING,
    });
    return parseDocx(buffer);
  }

  it('bare GENERAL/PRODUCTS/EXECUTION on non-pStyle-linked PART numbering yield 3 part roots (was 1)', async () => {
    const tree = await parseCpi();
    const partRoots = tree.parts.filter((n) => n.type === 'part');
    expect(partRoots.map((n) => n.text)).toEqual(['GENERAL', 'PRODUCTS', 'EXECUTION']);
  });

  it('an empty PART anchor on generic (non-PART) numbering drops — no spurious part', async () => {
    const tree = await parseCpi();
    // exactly 3 parts, none empty
    expect(tree.parts.filter((n) => n.type === 'part')).toHaveLength(3);
    expect(tree.parts.some((n) => n.type === 'part' && n.text.trim() === '')).toBe(false);
  });

  it('articles nest under their parts, never at root', async () => {
    const tree = await parseCpi();
    expect(tree.parts.filter((n) => n.type === 'article')).toHaveLength(0);
    const general = tree.parts.find((n) => n.text === 'GENERAL');
    expect(general?.children.some((c) => c.type === 'article' && c.text === 'SUMMARY')).toBe(true);
  });
});

// ── Table extraction wiring (#293): extractTables runs alongside the paragraph
//    walk and its results are folded into runPipeline's returned SpecTree — hidden
//    tables retained (ADR-038), visible tables surfaced as a table-content-skipped
//    warning. Table markup here mirrors tables.test.ts's own helper shapes. ──

function tableCell(paragraphsXml: string): string {
  return `<w:tc>${paragraphsXml}</w:tc>`;
}

function tableRow(cellsXml: string): string {
  return `<w:tr>${cellsXml}</w:tr>`;
}

function docxTable(rowsXml: string): string {
  return `<w:tbl>${rowsXml}</w:tbl>`;
}

function visibleTablePara(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function vanishTablePara(text: string): string {
  return `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
}

function docWithTables(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`;
}

describe('parseDocx — table extraction wiring (#293)', () => {
  it('INV-5: a hidden table is retained under tree.hiddenTables and emits no table-content-skipped warning', async () => {
    const hiddenTable = docxTable(
      tableRow(tableCell(vanishTablePara('secret A')) + tableCell(vanishTablePara('secret B')))
    );
    const documentXml = docWithTables(
      `<w:p><w:r><w:t>Plain paragraph text.</w:t></w:r></w:p>${hiddenTable}`
    );
    const tree = await parseDocx(await makeDocx({ documentXml }));

    expect(tree.hiddenTables).toEqual([{ rows: [['secret A', 'secret B']] }]);
    expect((tree.warnings ?? []).some((w) => w.type === 'table-content-skipped')).toBe(false);
  });

  it('INV-7: a visible table emits an exact table-content-skipped warning message and no hiddenTables', async () => {
    const visibleTable = docxTable(
      tableRow(tableCell(visibleTablePara('a')) + tableCell(visibleTablePara('b')))
    );
    // STRUCTURED_DOC/STRUCTURED_NUMBERING already resolves cleanly (no root-continuation
    // / no-structure-found) — isolates the assertion to exactly the table warning.
    const documentXml = STRUCTURED_DOC.replace('</w:body>', `${visibleTable}</w:body>`);
    const tree = await parseDocx(
      await makeDocx({ documentXml, numberingXml: STRUCTURED_NUMBERING })
    );

    expect(tree.warnings).toEqual([
      {
        type: 'table-content-skipped',
        suggestion: '1 visible table(s) detected but not yet modeled into the spec tree',
      },
    ]);
    expect(tree.hiddenTables).toBeUndefined();
  });

  it('INV-8: a hidden table, malformed core.xml, and a structural warning together — all three warning sources compose', async () => {
    const hiddenTable = docxTable(tableRow(tableCell(vanishTablePara('secret'))));
    const visibleTable = docxTable(
      tableRow(tableCell(visibleTablePara('shown a')) + tableCell(visibleTablePara('shown b')))
    );
    const documentXml = ARCAT_E2E_DOC.replace(
      '</w:body>',
      `${hiddenTable}${visibleTable}</w:body>`
    );
    const buffer = await makeDocx({
      documentXml,
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
      coreXml: '<<<not xml',
    });
    const tree = await parseDocx(buffer);

    const warningTypes = (tree.warnings ?? []).map((w) => w.type);
    expect(warningTypes).toContain('root-continuation');
    expect(warningTypes).toContain('core-metadata-unreadable');
    expect(warningTypes).toContain('table-content-skipped');
    expect(tree.hiddenTables).toEqual([{ rows: [['secret']] }]);
  });

  it('INV-9: no tables present — hiddenTables key is absent, never an empty array', async () => {
    const tree = await parseDocx(await makeDocx({}));

    expect(Object.prototype.hasOwnProperty.call(tree, 'hiddenTables')).toBe(false);
    expect((tree.warnings ?? []).some((w) => w.type === 'table-content-skipped')).toBe(false);
  });
});
