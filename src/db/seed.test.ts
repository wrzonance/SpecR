import { describe, it, expect } from 'vitest';
import { extractSectionMeta } from './seed.js';

describe('extractSectionMeta', () => {
  it('extracts section number and title from valid SEC content', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION 01 11 00</SCN><STL>SUMMARY OF WORK</STL></SEC>`;
    const result = extractSectionMeta(content);
    expect(result).toEqual({
      sectionNumber: '01 11 00',
      title: 'SUMMARY OF WORK',
      division: '01',
    });
  });

  it('returns null when SCN tag is missing', () => {
    const content = `<?xml version="1.0"?><SEC><STL>SOME TITLE</STL></SEC>`;
    expect(extractSectionMeta(content)).toBeNull();
  });

  it('returns null when STL tag is missing', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION 27 21 00</SCN></SEC>`;
    expect(extractSectionMeta(content)).toBeNull();
  });

  it('trims whitespace from extracted values', () => {
    const content = `<SEC><SCN>SECTION 27 21 00 </SCN><STL> Structured Cabling </STL></SEC>`;
    const result = extractSectionMeta(content);
    expect(result?.sectionNumber).toBe('27 21 00');
    expect(result?.title).toBe('Structured Cabling');
  });
});
