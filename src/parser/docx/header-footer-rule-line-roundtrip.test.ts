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

// #484 (task 3/5, ADR-068 addendum) — a true cross-module round-trip
// mirroring header-footer-table-roundtrip.test.ts's own #309 pattern: a
// standalone border-only rule-line paragraph captured off raw OOXML by the
// PARSER's captureRegion (resolveRuleLine) feeds directly into the
// GENERATOR's renderHeaderFooterComposition, packed through a real docx
// Packer and reopened via JSZip. header-footer-region.test.ts already pins
// resolveRuleLine's promotion/demotion behavior against the returned
// HeaderFooterRegion object in isolation, and header-footer-regions.test.ts
// already pins the generator's own ruleLine -> <w:pBdr> rendering from a
// hand-written HeaderFooterRegion — neither exercises the parser's actual
// promoted output as the generator's actual input. Before #484, a standalone
// rule-line paragraph with no content-bearing sibling was silently dropped
// (never reached `first`, so `region` came back undefined) — this is the
// suite that would have caught that regression at the real boundary.
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

// Mirrors header-footer-table-roundtrip.test.ts's own docWithHeadersFooters
// idiom — conditional spread keeps an absent `headers` key genuinely absent
// under exactOptionalPropertyTypes, rather than an explicit `headers: undefined`.
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
// possibly-undefined `table`/`ruleLine` into a region under
// exactOptionalPropertyTypes — never fabricating an explicit `header: undefined`
// key.
function compositionWithHeader(region: HeaderFooterRegion | undefined): HeaderFooterComposition {
  return compact({ header: region }) as HeaderFooterComposition;
}

describe('captureRegion → renderHeaderFooterComposition → Packer → JSZip round-trip (#484)', () => {
  it('a standalone border-only rule-line paragraph, with no content-bearing paragraph in the part at all, packs a real <w:pBdr> matching the source border', async () => {
    const xml = makeHdrXml(paragraph('<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>', ''));
    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    // Pin the parser-side promotion first (mirrors header-footer-region.test.ts):
    // widthTwips = round(4 / 0.4) = 10.
    expect(captured.region).toEqual({
      ruleLine: { enabled: true, style: 'single', widthTwips: 10 },
    });
    expect(captured.unmodeled).toEqual([]);

    const headerXml = await packedHeaderXml(compositionWithHeader(captured.region));

    // Generator recomputes w:sz from widthTwips (round(10 * 0.4) = 4) — the
    // packed value below is the inverse of the parser's own conversion, not
    // an echoed literal, so this proves the two conversions are actually
    // consistent round-trip inverses of each other, not merely that some
    // border survived.
    expect(headerXml).toContain('<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>');
    expect(headerXml).not.toContain('<w:t ');
  });

  it('the promoted first standalone rule-line paragraph renders once; the demoted second never duplicates a border or leaks as text', async () => {
    const rule = '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>';
    const xml = makeHdrXml(`${paragraph(rule, '')}${paragraph(rule, '')}`);
    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(captured.region?.ruleLine).toEqual({ enabled: true, style: 'single', widthTwips: 10 });
    expect(captured.unmodeled).toHaveLength(1);
    expect(captured.unmodeled[0]).toMatchObject({ kind: 'extraParagraph' });

    const headerXml = await packedHeaderXml(compositionWithHeader(captured.region));

    // Exactly one <w:pBdr> reaches the packed part: the demoted candidate's
    // `unmodeled` entry is data captureFromParagraphs returns alongside
    // `region`, but renderHeaderFooterComposition is only ever given
    // `region` (compositionWithHeader never threads `unmodeled` through) —
    // so a demotion bug that instead merged/duplicated candidates would
    // show up here as more than one border in the packed XML.
    expect(headerXml.match(/<w:pBdr>/g)).toHaveLength(1);
    expect(headerXml).toContain('<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>');
    expect(headerXml).not.toContain('<w:t ');
  });

  it('a content-bearing paragraph with no border and no standalone rule-line candidate packs no <w:pBdr> at all (regression guard)', async () => {
    const xml = makeHdrXml(paragraph('', textRun('Header text')));
    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(captured.region?.ruleLine).toBeUndefined();

    const headerXml = await packedHeaderXml(compositionWithHeader(captured.region));

    expect(headerXml).not.toContain('<w:pBdr>');
    expect(headerXml).toContain('Header text');
  });
});
