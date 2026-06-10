import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { resolveStyleCascade } from './resolver.js';
import { StylePropertiesSchema } from '../../ast/index.js';

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
});
