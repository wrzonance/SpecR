import { describe, it, expect, beforeAll } from 'vitest';
import { Document, Paragraph, TextRun, Packer } from 'docx';
import { parse } from '../index.js';
import type { SecRef } from '../../ast/types.js';

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

describe('integration: DOCX cross-reference extraction', () => {
  let refs: readonly SecRef[];

  beforeAll(async () => {
    const buffer = await buildDocxBuffer([
      'PART 1 - GENERAL',
      '1.1 REFERENCES',
      'A. See Section 09 91 00 for paint and coating requirements.',
      'B. Comply with ASTM C150 for cement.',
      'C. All wiring per NFPA 70 and IEEE 802.3 standards.',
      'D. Listed UL 94 V-0 plenum rated.',
      '1.2 SCOPE',
      'A. Work includes Section 26 05 19 conductors.',
    ]);
    const result = await parse(buffer, 'fixture.docx');
    refs = result.refs;
  });

  it('returns a non-empty refs array', () => {
    expect(refs.length).toBeGreaterThan(0);
  });

  it('extracts CSI section ref "Section 09 91 00"', () => {
    const sections = refs.filter((r) => r.targetType === 'section').map((r) => r.targetSpecSection);
    expect(sections).toContain('09 91 00');
  });

  it('extracts second CSI section ref "Section 26 05 19"', () => {
    const sections = refs.filter((r) => r.targetType === 'section').map((r) => r.targetSpecSection);
    expect(sections).toContain('26 05 19');
  });

  it('extracts ASTM standard ref "ASTM C150"', () => {
    const codes = refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode);
    expect(codes).toContain('ASTM C150');
  });

  it('extracts NFPA standard ref "NFPA 70"', () => {
    const codes = refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode);
    expect(codes).toContain('NFPA 70');
  });

  it('extracts IEEE standard ref "IEEE 802.3"', () => {
    const codes = refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode);
    expect(codes).toContain('IEEE 802.3');
  });

  it('extracts UL standard ref "UL 94"', () => {
    const codes = refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode);
    expect(codes).toContain('UL 94');
  });

  it('every ref has a non-empty sourceNodeId (valid UUID-ish)', () => {
    expect(refs.every((r) => r.sourceNodeId.length > 0)).toBe(true);
  });

  it('every ref has a non-empty referenceText', () => {
    expect(refs.every((r) => r.referenceText.length > 0)).toBe(true);
  });
});
