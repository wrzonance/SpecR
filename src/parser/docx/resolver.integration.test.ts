import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { resolveStyleCascade } from './resolver.js';
import { analyzeDocxStyles } from './index.js';
import { StylePropertiesSchema } from '../../ast/index.js';
import type { StyleProperties } from '../../ast/types.js';

// Extract rFonts record from a StyleProperties for assertion — avoids deep ?. chains.
function getRFonts(p: StyleProperties | undefined): Record<string, unknown> {
  return (p?.rPr?.rFonts as Record<string, unknown> | undefined) ?? {};
}

const FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');

describe.skipIf(!existsSync(FIXTURE))('resolveStyleCascade — real DOCX fixture', () => {
  it('resolves every paragraph style to a schema-valid StyleProperties', async () => {
    const zip = await JSZip.loadAsync(readFileSync(FIXTURE));
    const stylesFile = zip.file('word/styles.xml');
    if (!stylesFile) throw new Error('fixture missing word/styles.xml');
    const stylesXml = await stylesFile.async('string');
    const numberingFile = zip.file('word/numbering.xml');
    const numberingXml = numberingFile ? await numberingFile.async('string') : null;

    const map = resolveStyleCascade(stylesXml, numberingXml);
    expect(map.size).toBeGreaterThan(0);
    for (const props of map.values()) {
      expect(() => StylePropertiesSchema.parse(props)).not.toThrow();
    }
    // Not just schema-valid: at least one style must carry real extracted properties
    // (empty {} passes the open schema, so size>0 alone wouldn't catch an all-empty regression).
    const someNonEmpty = [...map.values()].some(
      (p) => (p.rPr && Object.keys(p.rPr).length > 0) || (p.pPr && Object.keys(p.pPr).length > 0)
    );
    expect(someNonEmpty).toBe(true);
  });

  it('3-arg call with fixture theme (if present) still schema-valid; no regression', async () => {
    const zip = await JSZip.loadAsync(readFileSync(FIXTURE));
    const stylesFile = zip.file('word/styles.xml');
    if (!stylesFile) throw new Error('fixture missing word/styles.xml');
    const stylesXml = await stylesFile.async('string');
    const numberingFile = zip.file('word/numbering.xml');
    const numberingXml = numberingFile ? await numberingFile.async('string') : null;
    const themeFile = zip.file('word/theme/theme1.xml');
    const themeXml = themeFile ? await themeFile.async('string') : null;

    const map = resolveStyleCascade(stylesXml, numberingXml, themeXml);
    expect(map.size).toBeGreaterThan(0);
    for (const [styleId, props] of map.entries()) {
      expect(() => StylePropertiesSchema.parse(props), `style ${styleId} invalid`).not.toThrow();
    }
  });
});

describe.skipIf(!existsSync(FIXTURE))('analyzeDocxStyles — theme integration', () => {
  it('analyzeDocxStyles fixture: classified + effective styles, schema-valid', async () => {
    const { classified, effectiveStyles } = await analyzeDocxStyles(readFileSync(FIXTURE));
    expect(classified.length).toBeGreaterThan(0);
    expect(effectiveStyles.size).toBeGreaterThan(0);
    for (const [id, props] of effectiveStyles.entries()) {
      expect(() => StylePropertiesSchema.parse(props), `${id} invalid`).not.toThrow();
    }
  });
});

// ─── In-memory DOCX with theme part ──────────────────────────────────────────
// Build a minimal DOCX (no DB required) and assert that theme tokens in styles
// are resolved by analyzeDocxStyles.

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test">
  <a:themeElements>
    <a:fontScheme name="Test">
      <a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Meiryo"/><a:cs typeface="Arial"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;

const STYLES_WITH_THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"
                  w:eastAsiaTheme="minorHAnsi" w:cstheme="minorBidi"/>
        <w:sz w:val="24"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:b/></w:rPr>
  </w:style>
</w:styles>`;

// Minimal document.xml with one paragraph using Normal style
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:r><w:t>PART 1 - GENERAL</w:t></w:r>
    </w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

async function buildMinimalDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/styles.xml', STYLES_WITH_THEME_XML);
  zip.file('word/document.xml', DOCUMENT_XML);
  zip.file('word/theme/theme1.xml', THEME_XML);
  // Minimal [Content_Types].xml so JSZip doesn't complain
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('analyzeDocxStyles — in-memory DOCX with theme part', () => {
  it('resolves minorHAnsi docDefault tokens to Calibri (minor.latin)', async () => {
    const buf = await buildMinimalDocx();
    const { effectiveStyles } = await analyzeDocxStyles(buf);
    // Extract rFonts once to avoid deep optional chains per line
    const fonts = getRFonts(effectiveStyles.get('Normal'));
    expect(fonts['ascii']).toBe('Calibri');
    expect(fonts['hAnsi']).toBe('Calibri');
    expect(fonts['eastAsia']).toBe('Calibri'); // eastAsiaTheme="minorHAnsi" → token minorHAnsi → minor.latin
    expect(fonts['cs']).toBe('Arial'); // cstheme="minorBidi" → minor.cs
    expect(fonts['asciiTheme']).toBe('minorHAnsi'); // provenance preserved
  });

  it('Heading1 resolves majorHAnsi to major.latin (Cambria)', async () => {
    const buf = await buildMinimalDocx();
    const { effectiveStyles } = await analyzeDocxStyles(buf);
    const fonts = getRFonts(effectiveStyles.get('Heading1'));
    expect(fonts['ascii']).toBe('Cambria');
    expect(fonts['hAnsi']).toBe('Cambria');
    expect(fonts['asciiTheme']).toBe('majorHAnsi');
  });

  it('all effective styles are schema-valid when theme is present', async () => {
    const buf = await buildMinimalDocx();
    const { effectiveStyles } = await analyzeDocxStyles(buf);
    for (const [id, props] of effectiveStyles.entries()) {
      expect(() => StylePropertiesSchema.parse(props), `${id} invalid`).not.toThrow();
    }
  });
});
