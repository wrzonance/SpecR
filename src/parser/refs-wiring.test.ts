import { describe, it, expect } from 'vitest';
import { parse } from './index.js';
import { Document, Paragraph, TextRun, Packer } from 'docx';

async function buildDocxBuffer(lines: readonly string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: lines.map(
          (l) =>
            new Paragraph({
              children: [new TextRun(l)],
            })
        ),
      },
    ],
  });
  return await Packer.toBuffer(doc);
}

describe('parse() orchestrator — DOCX refs wiring', () => {
  it('DOCX path returns refs from extractRefsFromTree (no longer empty)', async () => {
    const buffer = await buildDocxBuffer([
      'PART 1 - GENERAL',
      '1.1 REFERENCES',
      'A. See Section 09 91 00 and comply with ASTM C150.',
    ]);
    const result = await parse(buffer, 'fixture.docx');
    expect(result.refs.length).toBeGreaterThan(0);
    const targetSections = result.refs
      .filter((r) => r.targetType === 'section')
      .map((r) => r.targetSpecSection);
    const standardCodes = result.refs
      .filter((r) => r.targetType === 'standard')
      .map((r) => r.standardCode);
    expect(targetSections).toContain('09 91 00');
    expect(standardCodes).toContain('ASTM C150');
  });
});
