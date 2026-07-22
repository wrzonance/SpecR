import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseSectionHeaderFooterInfo } from './header-footer-relationships.js';
import { generateDocx } from '../../generator/index.js';
import type { SpecTree } from '../../ast/index.js';

// #509 review finding: every existing pageSize test only exercises one side
// of the boundary in isolation — header-footer-relationships.test.ts asserts
// the PARSER's extracted PageSize against synthetic w:pgSz fixtures, and
// generator/index.test.ts feeds hand-crafted PageSize objects straight into
// generateDocx. Neither pins the actual parse -> generate glue this feature
// promises: "a DOCX source with an explicit, valid w:pgSz reproduces the
// same width/height/orientation in the generated OOXML" (ADR-077). A
// regression that flips the twips-reading convention in extractPageSize
// (parser side) and independently flips the landscape swap direction in
// toDocxPageSize (generator side) in a way that happens to cancel out for
// each side's own hand-picked fixtures would pass every existing test while
// silently corrupting a real parse -> generate round trip.
//
// Mirrors the established cross-module round-trip convention in this same
// directory (header-footer-rule-line-roundtrip.test.ts,
// header-footer-table-roundtrip.test.ts, etc.): captureRegion here is
// swapped for parseSectionHeaderFooterInfo (also parser-owned, same
// module), and renderHeaderFooterComposition is swapped for generateDocx —
// both reached only through the generator's public barrel
// (../../generator/index.js), never a generator internal, per CLAUDE.md's
// module-boundary rule. This file lives in src/parser/docx/ alongside
// header-footer-relationships.ts (same module, not a boundary crossing).

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function makeDocXml(pgSzXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${NS}>
  <w:body>
    <w:p><w:r><w:t>Body paragraph.</w:t></w:r></w:p>
    <w:sectPr>${pgSzXml}</w:sectPr>
  </w:body>
</w:document>`;
}

function treeWithPageSize(pageSize: SpecTree['pageSize']): SpecTree {
  return {
    id: '00000000-0000-0000-0000-000000000900',
    section: '09 91 26',
    title: 'EXTERIOR PAINTING',
    parts: [],
    ...(pageSize !== undefined ? { pageSize } : {}),
  };
}

async function packedDocumentXml(tree: SpecTree): Promise<string> {
  const buffer = await generateDocx(tree);
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml missing from packed DOCX');
  return file.async('string');
}

describe('parseSectionHeaderFooterInfo → generateDocx → Packer → JSZip round-trip (#509, ADR-077)', () => {
  it('a captured portrait Letter w:pgSz reproduces the identical width/height/orientation in the generated document.xml', async () => {
    const xml = makeDocXml('<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>');
    const info = parseSectionHeaderFooterInfo(xml);
    expect(info.pageSize).toEqual({ width: 12240, height: 15840, orientation: 'portrait' });

    const documentXml = await packedDocumentXml(treeWithPageSize(info.pageSize));

    expect(documentXml).toContain('<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>');
  });

  // The case the finding calls out by name: a real landscape source must
  // survive BOTH conversions (parser's twips reading, generator's
  // orientation-driven swap) without a compensating double-swap collapsing
  // back to a coincidentally-correct portrait-shaped rectangle.
  it('a captured landscape A4 w:pgSz reproduces the identical width/height/orientation — not swapped, not double-swapped', async () => {
    const xml = makeDocXml('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
    const info = parseSectionHeaderFooterInfo(xml);
    expect(info.pageSize).toEqual({ width: 16838, height: 11906, orientation: 'landscape' });

    const documentXml = await packedDocumentXml(treeWithPageSize(info.pageSize));

    expect(documentXml).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
  });

  it('a captured w:pgSz with no @w:orient reproduces width/height — SpecR never fabricates an orientation the source didn’t declare (docx itself may default the attribute; that’s the library’s behavior, not SpecR’s)', async () => {
    const xml = makeDocXml('<w:pgSz w:w="12240" w:h="15840"/>');
    const info = parseSectionHeaderFooterInfo(xml);
    expect(info.pageSize).toEqual({ width: 12240, height: 15840 });
    expect(info.pageSize).not.toHaveProperty('orientation');

    const documentXml = await packedDocumentXml(treeWithPageSize(info.pageSize));

    expect(documentXml).toMatch(/<w:pgSz w:w="12240" w:h="15840"/);
  });

  it('a source with no w:pgSz at all parses to an undefined pageSize and the generator falls back to Letter — the same shared default path, not a round-trip failure', async () => {
    const xml = makeDocXml('');
    const info = parseSectionHeaderFooterInfo(xml);
    expect(info.pageSize).toBeUndefined();

    const documentXml = await packedDocumentXml(treeWithPageSize(info.pageSize));

    expect(documentXml).toContain('<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>');
  });
});
