import { describe, it, expect } from 'vitest';
import { asRecord, createDocumentXmlParser } from './xml-utils.js';
import { unwrapAlternateContent, classifyBodyDrawing } from './body-drawings.js';

// Real fast-xml-parser output, not hand-mocked records — mirrors
// header-footer-images.test.ts's own posture. fast-xml-parser isn't a
// namespace-validating parser, so a prefix used but not xmlns-declared
// (e.g. wpg: below) still parses fine; only the well-declared prefixes this
// suite actually round-trips through classifyBodyDrawing are declared.
const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"',
  'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"',
].join(' ');

const partParser = createDocumentXmlParser([]);

function parseRun(xml: string): Record<string, unknown> {
  const parsed = partParser.parse(xml) as Record<string, unknown>;
  const run = asRecord(parsed['w:r']);
  if (!run) throw new Error('test fixture parse failure: no w:r root');
  return run;
}

function drawingXml(innerXml: string): string {
  return `<w:drawing>${innerXml}</w:drawing>`;
}

function pictXml(innerXml: string): string {
  return `<w:pict>${innerXml}</w:pict>`;
}

function runWithDrawing(innerXml: string): Record<string, unknown> {
  return parseRun(`<w:r ${NS}>${drawingXml(innerXml)}</w:r>`);
}

function runWithPict(innerXml: string): Record<string, unknown> {
  return parseRun(`<w:r ${NS}>${pictXml(innerXml)}</w:r>`);
}

function runWithAlternateContent(
  choiceInnerXml: string,
  fallbackInnerXml: string
): Record<string, unknown> {
  return parseRun(
    `<w:r ${NS}><mc:AlternateContent>` +
      `<mc:Choice Requires="wps">${choiceInnerXml}</mc:Choice>` +
      `<mc:Fallback>${fallbackInnerXml}</mc:Fallback>` +
      `</mc:AlternateContent></w:r>`
  );
}

function inlineDrawing(bodyXml: string): string {
  return `<wp:inline>${bodyXml}</wp:inline>`;
}

function anchorDrawing(bodyXml: string): string {
  return `<wp:anchor>${bodyXml}</wp:anchor>`;
}

function graphicXml(graphicDataInnerXml: string, uri: string): string {
  return `<a:graphic><a:graphicData uri="${uri}">${graphicDataInnerXml}</a:graphicData></a:graphic>`;
}

const TEXTBOX_URI = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const PICTURE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DIAGRAM_URI = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const GROUP_URI = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';

function textBoxGraphicData(): string {
  return graphicXml(
    '<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>box text</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>',
    TEXTBOX_URI
  );
}

function imageGraphicData(rId = 'rId1'): string {
  return graphicXml(
    `<pic:pic><pic:blipFill><a:blip r:embed="${rId}"/></pic:blipFill></pic:pic>`,
    PICTURE_URI
  );
}

function chartGraphicData(): string {
  return graphicXml('<c:chart r:id="rId9"/>', CHART_URI);
}

function smartArtGraphicData(): string {
  return graphicXml('<dgm:relIds r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/>', DIAGRAM_URI);
}

// A group shape's own graphicData genuinely has no wps:txbx/pic:pic/c:chart/
// dgm:relIds child — an unrecognized-but-real DrawingML species, not a
// synthetic edge case.
function groupShapeGraphicData(): string {
  return graphicXml('<wpg:wgp/>', GROUP_URI);
}

function extentAndDocPr(): string {
  return '<wp:extent cx="100000" cy="100000"/><wp:docPr id="1"/>';
}

function vmlTextBox(style?: string): string {
  const styleAttr = style !== undefined ? ` style="${style}"` : '';
  return (
    `<v:shape${styleAttr}><v:textbox><w:txbxContent>` +
    '<w:p><w:r><w:t>vml box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape>'
  );
}

function vmlImage(): string {
  return '<v:shape><v:imagedata r:id="rId1"/></v:shape>';
}

function vmlOle(): string {
  return '<v:shape><o:OLEObject Type="Embed" ProgID="Excel.Sheet.12"/></v:shape>';
}

function vmlUnknownShape(): string {
  return '<v:shape><v:fill/></v:shape>';
}

describe('unwrapAlternateContent', () => {
  it('returns node unchanged when it carries no mc:AlternateContent (VML-only source)', () => {
    const run = runWithPict(vmlTextBox());
    expect(unwrapAlternateContent(run)).toEqual(run);
  });

  it('unwraps to the mc:Choice content, discarding mc:Fallback entirely', () => {
    const run = runWithAlternateContent(
      drawingXml(inlineDrawing(extentAndDocPr() + textBoxGraphicData())),
      pictXml(vmlTextBox())
    );
    const unwrapped = unwrapAlternateContent(run);
    expect('w:drawing' in unwrapped).toBe(true);
    expect('w:pict' in unwrapped).toBe(false);
  });

  it('returns node unchanged when mc:AlternateContent has no mc:Choice (defensive, never a real Word output)', () => {
    const run = parseRun(
      `<w:r ${NS}><mc:AlternateContent><mc:Fallback>${pictXml(vmlTextBox())}</mc:Fallback></mc:AlternateContent></w:r>`
    );
    expect(unwrapAlternateContent(run)).toEqual(run);
  });

  it('never mutates its input', () => {
    const run = runWithAlternateContent(
      drawingXml(inlineDrawing(extentAndDocPr() + textBoxGraphicData())),
      pictXml(vmlTextBox())
    );
    const before = JSON.parse(JSON.stringify(run)) as unknown;
    unwrapAlternateContent(run);
    expect(JSON.parse(JSON.stringify(run))).toEqual(before);
  });
});

describe('classifyBodyDrawing — DrawingML (w:drawing)', () => {
  it('classifies an inline wps text box as textBox/drawingml/non-floating', () => {
    const run = runWithDrawing(inlineDrawing(extentAndDocPr() + textBoxGraphicData()));
    expect(classifyBodyDrawing(run)).toEqual({
      kind: 'textBox',
      generation: 'drawingml',
      floating: false,
    });
  });

  it('classifies an anchored (floating) wps text box as floating:true', () => {
    const run = runWithDrawing(anchorDrawing(extentAndDocPr() + textBoxGraphicData()));
    expect(classifyBodyDrawing(run)).toEqual({
      kind: 'textBox',
      generation: 'drawingml',
      floating: true,
    });
  });

  it('classifies a pic:pic image as kind:image, reusing the pic:pic presence discriminator', () => {
    const run = runWithDrawing(inlineDrawing(extentAndDocPr() + imageGraphicData()));
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'image' });
  });

  it('classifies a chart graphicData as kind:chart', () => {
    const run = runWithDrawing(inlineDrawing(chartGraphicData()));
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'chart' });
  });

  it('classifies a diagram (smartArt) graphicData as kind:smartArt', () => {
    const run = runWithDrawing(inlineDrawing(smartArtGraphicData()));
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'smartArt' });
  });

  it('classifies an unrecognized graphicData species (group shape) as kind:unknown, never as textBox', () => {
    const run = runWithDrawing(inlineDrawing(groupShapeGraphicData()));
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'unknown' });
  });

  it('classifies a plain wps:wsp with no wps:txbx (an ordinary autoshape) as kind:unknown, never as textBox', () => {
    const run = runWithDrawing(inlineDrawing(graphicXml('<wps:wsp/>', TEXTBOX_URI)));
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'unknown' });
  });
});

describe('classifyBodyDrawing — VML (w:pict)', () => {
  it('classifies an inline v:textbox as textBox/vml/non-floating (no position style)', () => {
    const run = runWithPict(vmlTextBox());
    expect(classifyBodyDrawing(run)).toEqual({
      kind: 'textBox',
      generation: 'vml',
      floating: false,
    });
  });

  it('classifies a v:textbox with position:absolute style as floating:true', () => {
    const run = runWithPict(vmlTextBox('position:absolute;left:0;top:0;width:100pt;height:50pt'));
    expect(classifyBodyDrawing(run)).toEqual({
      kind: 'textBox',
      generation: 'vml',
      floating: true,
    });
  });

  it('classifies v:imagedata as kind:image', () => {
    const run = runWithPict(vmlImage());
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'image' });
  });

  it('classifies o:OLEObject as kind:ole', () => {
    const run = runWithPict(vmlOle());
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'ole' });
  });

  it('classifies an unrecognized v:shape body as kind:unknown, never as textBox', () => {
    const run = runWithPict(vmlUnknownShape());
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'unknown' });
  });

  it('classifies a w:pict with no v:shape at all as kind:unknown', () => {
    const run = runWithPict('<v:rect/>');
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'unknown' });
  });
});

describe('classifyBodyDrawing — mc:AlternateContent integration (decision 9)', () => {
  it('classifies the Choice (drawingml) branch, never the Fallback (vml) branch', () => {
    const run = runWithAlternateContent(
      drawingXml(inlineDrawing(extentAndDocPr() + textBoxGraphicData())),
      pictXml(vmlTextBox('position:absolute'))
    );
    expect(classifyBodyDrawing(unwrapAlternateContent(run))).toEqual({
      kind: 'textBox',
      generation: 'drawingml',
      floating: false,
    });
  });
});

describe('classifyBodyDrawing — no drawing content', () => {
  it('classifies a run with neither w:drawing nor w:pict as kind:unknown (never throws)', () => {
    const run = parseRun(`<w:r ${NS}><w:t>plain text</w:t></w:r>`);
    expect(classifyBodyDrawing(run)).toEqual({ kind: 'unknown' });
  });
});

// KNOWN AMBIGUITY (decision 3, ADR-072): a floating object's HOST paragraph
// (where its run sits in document order) is the only placement SpecR ever
// records. A wp:anchor's own offset geometry can visually place the shape
// far from that host paragraph — SpecR never attempts to resolve or reflect
// that visual position; floating classification is wp:anchor-vs-wp:inline
// presence ONLY, regardless of how extreme the anchor's own offsets are.
describe('classifyBodyDrawing — KNOWN AMBIGUITY: host-vs-visual floating placement (decision 3)', () => {
  it('still reports floating:true (and the same kind) for a wp:anchor with a large negative visual offset — the offset is never inspected', () => {
    const offsetGeometry =
      '<wp:positionH relativeFrom="page"><wp:posOffset>-9144000</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="page"><wp:posOffset>9144000</wp:posOffset></wp:positionV>';
    const run = runWithDrawing(
      anchorDrawing(offsetGeometry + extentAndDocPr() + textBoxGraphicData())
    );
    expect(classifyBodyDrawing(run)).toEqual({
      kind: 'textBox',
      generation: 'drawingml',
      floating: true,
    });
  });
});
