import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeDocxStyles } from './index.js';
import { ParserError } from '../error.js';

const FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');

describe.skipIf(!existsSync(FIXTURE))('analyzeDocxStyles — real DOCX fixture', () => {
  it('returns classified paragraphs and effective styles from one buffer', async () => {
    const { classified, effectiveStyles } = await analyzeDocxStyles(readFileSync(FIXTURE));
    expect(classified.length).toBeGreaterThan(0);
    expect(effectiveStyles.size).toBeGreaterThan(0);
    const styleable = classified.filter((c) =>
      ['part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7'].includes(c.nodeType)
    );
    expect(styleable.length).toBeGreaterThan(0);
  });
});

// Not fixture-dependent — must run even when the DOCX fixture is absent.
describe('analyzeDocxStyles — error paths', () => {
  it('throws ParserError on a non-DOCX buffer', async () => {
    await expect(analyzeDocxStyles(Buffer.from('not a zip'))).rejects.toThrow(ParserError);
  });
});
