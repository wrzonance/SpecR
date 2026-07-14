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

// #309 (task 6/6, ADR-071) — a true cross-module round-trip: a real w:tbl
// captured off raw OOXML by the PARSER's captureRegion feeds directly into
// the GENERATOR's renderHeaderFooterComposition, packed through a real docx
// Packer and reopened via JSZip. Every other #309 suite tests one side of
// this boundary in isolation (header-footer-table.test.ts feeds captureRegion
// hand-written XML and asserts on the returned HeaderFooterTable object;
// header-footer-tables.test.ts / header-footer.test.ts feed buildTable /
// renderHeaderFooterComposition a hand-written HeaderFooterTable object) —
// neither exercises the parser's actual output as the generator's actual
// input. This file is what would have caught a shape mismatch between the
// two sides that both isolated suites, individually, would still pass.
//
// Per CLAUDE.md's module-boundary rule, this file lives in src/parser/docx/
// (same directory as captureRegion/compact — same-module, not a boundary
// crossing) and reaches the generator only through its public barrel
// (../../generator/index.js), never a generator internal.

const KNOWN = { section: '09 91 26', title: 'EXTERIOR PAINTING' };

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '09 91 26',
  sectionTitle: 'EXTERIOR PAINTING',
  current: {},
};

function makeHdrXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bodyXml}</w:hdr>`;
}

function paragraph(runsXml: string): string {
  return `<w:p>${runsXml}</w:p>`;
}

function textRun(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

function cell(pXml: string): string {
  return `<w:tc>${pXml}</w:tc>`;
}

function row(cellsXml: string): string {
  return `<w:tr>${cellsXml}</w:tr>`;
}

function table(rowsXml: string, tblPrXml = ''): string {
  return `<w:tbl>${tblPrXml}${rowsXml}</w:tbl>`;
}

// Mirrors header-footer.test.ts's own docWithHeadersFooters JSZip idiom —
// conditional spread keeps an absent `headers` key genuinely absent under
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

// compact() + `as HeaderFooterRegion`/`HeaderFooterComposition` mirrors the
// exact idiom header-footer-region.ts's own captureRegion tail uses to fold
// a possibly-undefined `table` into a region under exactOptionalPropertyTypes
// — never fabricating an explicit `table: undefined` key.
function compositionWithHeader(region: HeaderFooterRegion | undefined): HeaderFooterComposition {
  return compact({ header: region }) as HeaderFooterComposition;
}

describe('captureRegion → renderHeaderFooterComposition → Packer → JSZip round-trip (#309)', () => {
  it('carries a captured two-cell table, one literal + one modeled sectionNumber field, into a real packed <w:tbl>', async () => {
    const xml = makeHdrXml(
      table(row(cell(paragraph(textRun('Drawing No.'))) + cell(paragraph(textRun('09 91 26')))))
    );
    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(captured.region?.table).toBeDefined();
    expect(captured.unmodeled).toEqual([]);

    const headerXml = await packedHeaderXml(compositionWithHeader(captured.region));

    expect(headerXml).toContain('<w:tbl>');
    expect(headerXml).toContain('Drawing No.');
    // the second cell was captured as a modeled `sectionNumber` field (not
    // literal text) — the packed XML must carry the *resolved* value from
    // CTX, proving the field survived the parser→generator handoff typed,
    // not just as a passthrough string.
    expect(headerXml).toContain('09 91 26');
  });

  it('carries captured w:tblGrid column widths through into a real packed <w:tblGrid>', async () => {
    const xml = makeHdrXml(
      table(
        row(cell(paragraph(textRun('A'))) + cell(paragraph(textRun('B')))),
        '<w:tblGrid><w:gridCol w:w="1440"/><w:gridCol w:w="2880"/></w:tblGrid>'
      )
    );
    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(captured.region?.table?.columnWidths).toEqual([1440, 2880]);

    const headerXml = await packedHeaderXml(compositionWithHeader(captured.region));

    expect(headerXml).toContain('<w:tblGrid>');
    expect(headerXml).toContain('w:w="1440"');
    expect(headerXml).toContain('w:w="2880"');
  });

  it('a structurally disqualified table (nested w:tbl) never reaches the generator — no header content is fabricated end to end', () => {
    const nestedTbl = table(row(cell(paragraph(textRun('nested')))));
    const xml = makeHdrXml(table(row(cell(nestedTbl))));
    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(captured.region?.table).toBeUndefined();
    // the whole region — not just .table — is undefined here: the source
    // XML has nothing BUT the disqualified table, so there is no left/
    // center/right paragraph content either for captureRegion to capture.
    expect(captured.region).toBeUndefined();

    const result = renderHeaderFooterComposition(compositionWithHeader(captured.region), CTX);
    expect(result.headers).toBeUndefined();
  });
});
