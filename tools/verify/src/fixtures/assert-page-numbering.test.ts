// assertPageNumberingRestart tests (#305 task 4/7). Hand-built minimal DOCX
// buffers via JSZip directly — no dependency on the `docx` package or the
// header-footer-scenarios fixture catalog, so this pins the helper's own
// contract in isolation: it reads word/document.xml's trailing sectPr and
// throws VerifyRenderError naming the actual state found on any mismatch.

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { VerifyRenderError } from '../errors.js';
import { assertPageNumberingRestart } from './assert-page-numbering.js';

function documentXmlWith(sectPrBody: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>body</w:t></w:r></w:p>' +
    `<w:sectPr>${sectPrBody}</w:sectPr>` +
    '</w:body></w:document>'
  );
}

// A two-section document: an earlier section-ending sectPr (inside a
// paragraph's pPr) plus the trailing body-level sectPr. Exercises the
// "read the FINAL sectPr" contract — an unscoped scan would return the
// first section's w:pgNumType.
function documentXmlWithTwoSections(firstSectPrBody: string, trailingSectPrBody: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:pPr><w:sectPr>${firstSectPrBody}</w:sectPr></w:pPr>` +
    '<w:r><w:t>section one</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>section two</w:t></w:r></w:p>' +
    `<w:sectPr>${trailingSectPrBody}</w:sectPr>` +
    '</w:body></w:document>'
  );
}

async function docxBufferWithDocumentXml(documentXml: string | null): Promise<Buffer> {
  const zip = new JSZip();
  if (documentXml !== null) zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('assertPageNumberingRestart', () => {
  it('resolves when word/document.xml carries the expected w:pgNumType w:start value', async () => {
    const buffer = await docxBufferWithDocumentXml(documentXmlWith('<w:pgNumType w:start="1"/>'));

    await expect(assertPageNumberingRestart(buffer, 1)).resolves.toBeUndefined();
  });

  it('throws VerifyRenderError naming the mismatched start value actually found', async () => {
    const buffer = await docxBufferWithDocumentXml(documentXmlWith('<w:pgNumType w:start="3"/>'));

    await expect(assertPageNumberingRestart(buffer, 1)).rejects.toThrow(
      /expected .*w:start="1".*found w:start="3"/
    );
    await expect(assertPageNumberingRestart(buffer, 1)).rejects.toBeInstanceOf(VerifyRenderError);
  });

  it("throws VerifyRenderError naming 'not found' when no w:pgNumType element is present", async () => {
    const buffer = await docxBufferWithDocumentXml(documentXmlWith('<w:pgSz w:w="11906"/>'));

    await expect(assertPageNumberingRestart(buffer, 1)).rejects.toThrow(
      /expected .*w:start="1".*found not found/
    );
  });

  it('reads the trailing sectPr, ignoring an earlier section that carries the restart', async () => {
    // First section restarts at 1; the trailing (asserted) section does not.
    // An unscoped first-match scan would wrongly pass here.
    const buffer = await docxBufferWithDocumentXml(
      documentXmlWithTwoSections('<w:pgNumType w:start="1"/>', '<w:pgSz w:w="11906"/>')
    );

    await expect(assertPageNumberingRestart(buffer, 1)).rejects.toThrow(
      /expected .*w:start="1".*found not found/
    );
  });

  it('resolves when the trailing sectPr carries the restart even if an earlier one does not', async () => {
    const buffer = await docxBufferWithDocumentXml(
      documentXmlWithTwoSections('<w:pgSz w:w="11906"/>', '<w:pgNumType w:start="1"/>')
    );

    await expect(assertPageNumberingRestart(buffer, 1)).resolves.toBeUndefined();
  });

  it('throws VerifyRenderError (stage report) when word/document.xml is missing entirely', async () => {
    const buffer = await docxBufferWithDocumentXml(null);

    await expect(assertPageNumberingRestart(buffer, 1)).rejects.toMatchObject({ stage: 'report' });
  });

  it('throws VerifyRenderError when the buffer is not a readable zip archive at all', async () => {
    const buffer = Buffer.from('not a zip file');

    await expect(assertPageNumberingRestart(buffer, 1)).rejects.toMatchObject({ stage: 'report' });
  });
});
