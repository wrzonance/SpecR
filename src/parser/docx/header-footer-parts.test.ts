import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readHeaderFooterParts } from './header-footer-parts.js';

function makeZip(files: Record<string, string>): JSZip {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip;
}

describe('readHeaderFooterParts', () => {
  it('discovers word/header*.xml and word/footer*.xml parts keyed by full zip path', async () => {
    const zip = makeZip({
      'word/document.xml': '<w:document/>',
      'word/header1.xml': '<w:hdr>header one</w:hdr>',
      'word/footer1.xml': '<w:ftr>footer one</w:ftr>',
    });
    const { headerParts, footerParts } = await readHeaderFooterParts(zip);
    expect(headerParts.get('word/header1.xml')).toBe('<w:hdr>header one</w:hdr>');
    expect(footerParts.get('word/footer1.xml')).toBe('<w:ftr>footer one</w:ftr>');
  });

  it('makes no fixed-name assumption — discovers arbitrarily/non-sequentially numbered parts', async () => {
    const zip = makeZip({
      'word/header2.xml': '<w:hdr>two</w:hdr>',
      'word/header10.xml': '<w:hdr>ten</w:hdr>',
      'word/footer3.xml': '<w:ftr>three</w:ftr>',
    });
    const { headerParts, footerParts } = await readHeaderFooterParts(zip);
    expect([...headerParts.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'word/header10.xml',
      'word/header2.xml',
    ]);
    expect([...footerParts.keys()]).toEqual(['word/footer3.xml']);
  });

  it('yields empty maps, not a throw, for a document with no header/footer parts', async () => {
    const zip = makeZip({ 'word/document.xml': '<w:document/>' });
    const { headerParts, footerParts } = await readHeaderFooterParts(zip);
    expect(headerParts.size).toBe(0);
    expect(footerParts.size).toBe(0);
  });

  it('does not match parts outside word/ or names that merely contain "header"/"footer"', async () => {
    const zip = makeZip({
      'customXml/header1.xml': '<w:hdr>should not match</w:hdr>',
      'word/header-styles.xml': '<w:hdrStyles/>',
      'word/headerReference.xml': '<w:ref/>',
    });
    const { headerParts, footerParts } = await readHeaderFooterParts(zip);
    expect(headerParts.size).toBe(0);
    expect(footerParts.size).toBe(0);
  });
});
