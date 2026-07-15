import { describe, it, expect } from 'vitest';
import { Document, Packer } from 'docx';
import type { Header } from 'docx';
import JSZip from 'jszip';
import { captureRegion } from './header-footer-region.js';
import type { HeaderFooterRegion } from './header-footer-region.js';
import { compact } from './xml-utils.js';
import { renderHeaderFooterComposition } from '../../generator/index.js';
import type { HeaderFooterFieldContext } from '../../generator/index.js';
import type { HeaderFooterComposition } from '../../ast/index.js';

// #485 (task 5/6, ADR-068 posture) — a true cross-module round-trip mirroring
// header-footer-rule-line-roundtrip.test.ts's own #484 pattern: a PAGE field
// authored as Word's single-tag `w:fldSimple` shorthand (rather than the
// three-run `w:fldChar` begin/separate/end sequence) is captured off raw
// OOXML by the PARSER's captureRegion, fed into the GENERATOR's
// renderHeaderFooterComposition, packed through a real docx Packer, and
// reopened via JSZip. header-footer-region.test.ts already pins runsOf's
// w:fldSimple terminal handling and captureRegion's recognition of the
// resulting { kind: 'pageNumber' } field in isolation — neither exercises the
// generator's actual regenerated output. This is the suite that proves a
// w:fldSimple-authored field regenerates as a REAL Word field
// (w:fldChar/instrText PAGE sequence), not the field's cached display text
// leaking through as static content, and that no generator code change was
// needed to get there (Decision 5 / Interface E: FIELD_RESOLVERS operates
// purely on AST-level HeaderFooterField.kind, with zero OOXML-origin
// awareness).
//
// Per CLAUDE.md's module-boundary rule, this file lives in src/parser/docx/
// (same directory as captureRegion/compact — same-module, not a boundary
// crossing) and reaches the generator only through its public barrel
// (../../generator/index.js), never a generator internal.

const KNOWN = { section: '09 91 26', title: 'EXTERIOR PAINTING' };

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '23 05 00',
  sectionTitle: 'EXTERIOR PAINTING',
  current: {},
};

function makeHdrXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bodyXml}</w:hdr>`;
}

function paragraph(pPrXml: string, runsXml: string): string {
  const pPr = pPrXml === '' ? '' : `<w:pPr>${pPrXml}</w:pPr>`;
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

function textRun(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

// Word's single-tag field shorthand (#485) — @_w:instr carries the field
// code, and the cached display text sits in a nested w:r. A local copy of
// header-footer-region.test.ts's own simpleFieldRun helper — that helper is
// private to its own test file, and header-footer-rule-line-roundtrip.test.ts
// establishes the precedent of each round-trip file keeping its own copies
// of paragraph/textRun rather than importing another test file's internals.
function simpleFieldRun(instr: string, cachedText: string): string {
  return `<w:fldSimple w:instr="${instr}"><w:r><w:t>${cachedText}</w:t></w:r></w:fldSimple>`;
}

// Mirrors header-footer-rule-line-roundtrip.test.ts's own docWithHeader idiom
// — conditional spread keeps an absent `headers` key genuinely absent under
// exactOptionalPropertyTypes, rather than an explicit `headers: undefined`.
function docWithHeader(headers: Partial<Record<'default', Header>> | undefined): Document {
  return new Document({
    sections: [{ ...(headers !== undefined ? { headers } : {}), children: [] }],
  });
}

async function packedHeaderXml(composition: HeaderFooterComposition): Promise<string> {
  const result = renderHeaderFooterComposition(composition, CTX);
  const zip = await JSZip.loadAsync(await Packer.toBuffer(docWithHeader(result.headers)));
  const file = zip.file('word/header1.xml');
  if (!file) throw new Error('word/header1.xml missing from packed DOCX');
  return file.async('string');
}

// compact() + `as HeaderFooterComposition` mirrors the exact idiom
// header-footer-region.ts's own captureRegion tail uses to fold a
// possibly-undefined `header` into a composition under
// exactOptionalPropertyTypes, never fabricating an explicit `header: undefined`
// key.
function compositionWithHeader(region: HeaderFooterRegion | undefined): HeaderFooterComposition {
  return compact({ header: region }) as HeaderFooterComposition;
}

describe('captureRegion → renderHeaderFooterComposition → Packer → JSZip round-trip — w:fldSimple PAGE field (#485)', () => {
  it('a w:fldSimple PAGE field parses to a modeled pageNumber field and regenerates as a real Word field, not the cached display text', async () => {
    const xml = makeHdrXml(paragraph('', `${textRun('Page ')}${simpleFieldRun(' PAGE ', '3')}`));
    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);

    // Pin the parser-side recognition first (mirrors
    // header-footer-region.test.ts's own w:fldSimple PAGE assertion): the
    // field collapses to { kind: 'pageNumber' }, never a literal '3'.
    expect(captured.region?.left?.content).toEqual([
      { kind: 'literal', text: 'Page ' },
      { kind: 'pageNumber' },
    ]);
    expect(captured.unmodeled).toEqual([]);

    const headerXml = await packedHeaderXml(compositionWithHeader(captured.region));

    // The regenerated part carries a real Word PAGE field instruction — the
    // begin/separate/end w:fldChar sequence docx emits for PageNumber.CURRENT
    // — proving the generator re-derives a live field from the AST-level
    // `pageNumber` kind rather than replaying the source w:fldSimple's cached
    // display text ('3') as static content.
    expect(headerXml).toMatch(/instrText[^>]*>PAGE</);
    expect((headerXml.match(/w:fldCharType="begin"/g) ?? []).length).toBe(1);
    expect((headerXml.match(/w:fldCharType="end"/g) ?? []).length).toBe(1);
    expect(headerXml).not.toContain('w:fldSimple');
    expect(headerXml).toContain('Page');
    expect(headerXml).not.toMatch(/<w:t[^>]*>3<\/w:t>/);
  });
});
