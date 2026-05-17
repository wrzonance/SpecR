import { describe, it, expect, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pool, lookupCsiSectionTitle } from '../db/index.js';
import { loadFiles } from './file-loader.js';
import { parse } from '../parser/index.js';

const PROJECT_ROOT = path.resolve(process.cwd());
const ARCAT_DOCX = path.join(PROJECT_ROOT, 'docs/references/ARCAT/26_09_33.docx');
const UFGS_SEC = path.join(PROJECT_ROOT, 'docs/references/UFGS/DIVISION_27/27_10_00.SEC');

const ARCAT_AVAILABLE = existsSync(ARCAT_DOCX);

afterAll(async () => {
  await pool.end();
});

describe('lookupCsiSectionTitle', () => {
  it('returns standard title for known CSI section', async () => {
    const title = await lookupCsiSectionTitle('27 10 00');
    expect(typeof title).toBe('string');
    expect((title ?? '').length).toBeGreaterThan(0);
  });

  it('returns null for section not in csi_sections', async () => {
    const title = await lookupCsiSectionTitle('99 99 99');
    expect(title).toBeNull();
  });
});

describe.skipIf(!ARCAT_AVAILABLE)('parse() with ARCAT DOCX — content inference', () => {
  it('infers a valid CSI section number from content', async () => {
    const buffer = await readFile(ARCAT_DOCX);
    const result = await parse(buffer, ARCAT_DOCX);
    // ARCAT docs lack dc:subject — inference should fire
    expect(result.sectionInference.method).not.toBe('none');
    if (result.sectionInference.confidence !== 'none') {
      expect(result.sectionInference.inferredSection).toMatch(/^\d{2} \d{2} \d{2}$/);
      expect(result.tree.section).toBe(result.sectionInference.inferredSection);
    }
  });
});

describe('parse() with UFGS SEC — metadata path', () => {
  it('uses existing metadata — no content inference fired', async () => {
    const buffer = await readFile(UFGS_SEC);
    const result = await parse(buffer, UFGS_SEC);
    expect(result.sectionInference.method).toBe('metadata');
    expect(result.tree.section).toBe('27 10 00');
  });
});

describe('loadFiles() with inference warnings', () => {
  it('UFGS SEC produces no inferenceWarnings', async () => {
    const result = await loadFiles([UFGS_SEC]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.inferenceWarnings).toHaveLength(0);
  });

  it.skipIf(!ARCAT_AVAILABLE)('inferenceWarning structure is valid when present', async () => {
    const result = await loadFiles([ARCAT_DOCX]);
    expect(result.failed).toBe(0);
    for (const w of result.inferenceWarnings) {
      expect(w.inferredSection).toMatch(/^\d{2} \d{2} \d{2}$/);
      expect(w.confidence).toMatch(/^(high|medium)$/);
      expect(w.titleMatch).toMatch(/^(exact|close|divergent|unknown)$/);
      expect(typeof w.note).toBe('string');
    }
  });
});
