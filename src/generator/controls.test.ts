import { describe, it, expect } from 'vitest';
import { Paragraph, TextRun } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';

describe('wrapWithControl', () => {
  it('returns an SdtBlock instance', () => {
    const para = new Paragraph({ children: [new TextRun('test')] });
    const result = wrapWithControl(para, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(result).toBeInstanceOf(SdtBlock);
  });

  it('SdtBlock is an XmlComponent (prepForXml exists)', () => {
    const para = new Paragraph({ children: [new TextRun('test')] });
    const sdt = wrapWithControl(para, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(typeof sdt.prepForXml).toBe('function');
  });

  it('returns distinct instances for distinct paragraphs', () => {
    const p1 = new Paragraph({ children: [new TextRun('a')] });
    const p2 = new Paragraph({ children: [new TextRun('b')] });
    const s1 = wrapWithControl(p1, 'uuid-1');
    const s2 = wrapWithControl(p2, 'uuid-2');
    expect(s1).not.toBe(s2);
  });
});
