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

  it('seed: extractSectionMeta retains .43 suffix, division still 27', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION 27 05 13.43</SCN><STL>TV DISTRIBUTION</STL></SEC>`;
    expect(extractSectionMeta(content)).toEqual({
      sectionNumber: '27 05 13.43',
      title: 'TV DISTRIBUTION',
      division: '27',
    });
  });

  it('seed: bare SCN without SECTION prefix yields section', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>01 31 23.13 20</SCN><STL>SUSTAINABILITY REPORTING</STL></SEC>`;
    expect(extractSectionMeta(content)?.sectionNumber).toBe('01 31 23.13 20');
  });

  it('seed: whitespace dirt in SCN normalizes to canonical form', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION 26  00 13.10 </SCN><STL>X</STL></SEC>`;
    expect(extractSectionMeta(content)?.sectionNumber).toBe('26 00 13.10');
  });

  it('seed: unnormalizable SCN content is skipped (null), not seeded dirty', () => {
    const content = `<?xml version="1.0"?><SEC><SCN>SECTION TBD</SCN><STL>X</STL></SEC>`;
    expect(extractSectionMeta(content)).toBeNull();
  });

  it('seed: leading whitespace before SECTION keyword tolerated (26_29_23.SEC corpus shape)', () => {
    const content = `<?xml version="1.0"?><SEC><SCN> SECTION 26 29 23</SCN><STL>X</STL></SEC>`;
    expect(extractSectionMeta(content)?.sectionNumber).toBe('26 29 23');
  });
});
