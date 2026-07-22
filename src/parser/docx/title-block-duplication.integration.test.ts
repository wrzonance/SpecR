import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { parseDocx } from './index.js';
import { parse } from '../index.js';

const SECTION = '01 88 13.13';
const TITLE = 'CLEAN ZONE PRE-CERTIFICATION PROTOCOLS';

function leakedIdentityRoots(
  tree: Awaited<ReturnType<typeof parseDocx>>
): Awaited<ReturnType<typeof parseDocx>>['parts'] {
  // No root continuation re-types the tree's own already-resolved identity.
  return tree.parts.filter(
    (n) =>
      n.type !== 'part' &&
      (n.text.trim().toUpperCase() === tree.title.trim().toUpperCase() ||
        n.text.replace(/^SECTION\s+/i, '').trim() === tree.section)
  );
}

const CORE_XML = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:subject>${SECTION}</dc:subject>
  <dc:title>${TITLE}</dc:title>
</cp:coreProperties>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="multilevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="PART %1"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

// The opening body text types the "SECTION <n>" / title lines out longhand
// ("SECTION 01 88 13.13" / the section's own title), duplicating the
// generator's injected canonical heading on round-trip (#510). Before the fix
// these two lines survived as continuation SpecNodes at the root of the tree,
// ahead of the first real PART.
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>SECTION ${SECTION}</w:t></w:r></w:p>
    <w:p><w:r><w:t>${TITLE}</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
  </w:body>
</w:document>`;

async function buildTitleBlockDuplicationDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/styles.xml', STYLES_XML);
  zip.file('word/document.xml', DOCUMENT_XML);
  zip.file('word/numbering.xml', NUMBERING_XML);
  zip.file('docProps/core.xml', CORE_XML);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// Same shape as above but with NO docProps/core.xml — section/title are recovered
// by content inference (the common case for hand-authored/foreign DOCX, and the
// shape the #510 evidence describes: the source types "01 8813.13", which only the
// canonicalizing content-inference path resolves to "01 88 13.13"). The source
// SECTION line is typed longhand to exercise that canonicalization.
const DOCUMENT_XML_LONGHAND = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>SECTION 01 8813.13</w:t></w:r></w:p>
    <w:p><w:r><w:t>${TITLE}</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
  </w:body>
</w:document>`;

async function buildTitleBlockDuplicationDocxNoCore(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/styles.xml', STYLES_XML);
  zip.file('word/document.xml', DOCUMENT_XML_LONGHAND);
  zip.file('word/numbering.xml', NUMBERING_XML);
  // Deliberately NO docProps/core.xml — identity comes from content inference.
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('#510 leading title-block suppression — a synthetic doc (always runs in CI)', () => {
  it('drops the leading SECTION-line + title-line pair, leaving only PART roots', async () => {
    const buffer = await buildTitleBlockDuplicationDocx();
    const tree = await parseDocx(buffer);

    expect(leakedIdentityRoots(tree)).toHaveLength(0);
    // Every root is a real PART heading — the duplicated lines produced no
    // SpecNode at all, matching the #292 "suppressed -> no SpecNode" precedent.
    expect(tree.parts.every((n) => n.type === 'part')).toBe(true);
  });
});

// Regression (Codex draft review, P1): buildTree's classified-level strip only
// has the core.xml identity, so a DOCX WITHOUT docProps/core.xml — identity
// recovered by content inference — reached the tree with both duplicate lines
// still standing as root continuations. The parser's post-inference
// stripLeadingTitleBlockRoots pass closes that gap. Uses parse() (not parseDocx)
// because content inference runs in the parser orchestrator, not the DOCX parser.
describe('#510 leading title-block suppression — content-inferred identity (no core.xml)', () => {
  it('drops the leading SECTION-line + title-line pair when section/title come from content inference', async () => {
    const buffer = await buildTitleBlockDuplicationDocxNoCore();
    const { tree, sectionInference } = await parse(buffer, 'no-core.docx');

    // Precondition: identity really did come from content, not metadata — else
    // this would silently re-test the core.xml path above.
    expect(sectionInference.method).not.toBe('metadata');
    expect(tree.section).toBe(SECTION);
    expect(tree.title).toBe(TITLE);

    expect(leakedIdentityRoots(tree)).toHaveLength(0);
    expect(tree.parts.every((n) => n.type === 'part')).toBe(true);
  });
});

// A real hand-authored artifact reproducing the same shape as the synthetic doc
// above, kept as an extra real-world check when present. The file is gitignored
// manufacturer example data — present only in local dev, so this suite skips
// automatically when it is absent (including in CI); the synthetic test above
// is what guarantees acceptance-criterion coverage runs every time.
const ARTIFACT = resolve('docs/references/MANUFACTURER_EXAMPLES/parsing-needs-fixing.docx');

describe.runIf(existsSync(ARTIFACT))(
  '#510 leading title-block suppression — a hand-authored doc',
  () => {
    it('drops the leading SECTION-line + title-line pair, leaving only PART roots', async () => {
      const buffer = readFileSync(ARTIFACT);
      const tree = await parseDocx(buffer);

      expect(leakedIdentityRoots(tree)).toHaveLength(0);
      // Every root is a real PART heading — the duplicated lines produced no
      // SpecNode at all, matching the #292 "suppressed -> no SpecNode" precedent.
      expect(tree.parts.every((n) => n.type === 'part')).toBe(true);
    });
  }
);
