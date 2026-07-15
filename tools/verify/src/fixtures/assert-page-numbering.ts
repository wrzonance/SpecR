// Page-numbering-restart assertion helper for the header/footer fixture
// harness (#305 task 4/7). Confirms a generated DOCX's word/document.xml
// trailing sectPr carries `<w:pgNumType w:start="N"/>` for the expected
// restart value — the OOXML-level ground truth for
// HeaderFooterCompositionInput's pageNumbering.mode === 'restartPerSpec'
// (api-client/project-client.ts), independent of whatever a docx-preview
// render happens to show a human reviewer.

import JSZip from 'jszip';
import { VerifyRenderError } from '../errors.js';

async function readDocumentXml(docxBuffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(docxBuffer);
  } catch (err) {
    throw new VerifyRenderError('generated DOCX is not a readable zip archive', {
      stage: 'report',
      cause: err,
    });
  }
  const entry = zip.file('word/document.xml');
  if (entry === null) {
    throw new VerifyRenderError('generated DOCX is missing word/document.xml', {
      stage: 'report',
    });
  }
  return entry.async('string');
}

// Index of the FINAL w:sectPr open tag (`<w:sectPr>` or `<w:sectPr ...>`),
// or -1 if none. The `[\s>]` guard excludes `<w:sectPrChange>` (a revision
// child that lives INSIDE a sectPr), so this lands on the real trailing
// section-properties element even in a tracked-changes document.
function lastSectPrIndex(documentXml: string): number {
  const opens = /<w:sectPr[\s>]/g;
  let index = -1;
  for (let match = opens.exec(documentXml); match !== null; match = opens.exec(documentXml)) {
    index = match.index;
  }
  return index;
}

function extractPgNumStart(documentXml: string): string | null {
  // Scope the search to the FINAL w:sectPr (the body-level section
  // properties). A multi-section DOCX carries a w:sectPr per section, and
  // only the trailing one governs the asserted spec's page numbering — an
  // unscoped scan would return an earlier section's w:pgNumType and pass
  // even when the trailing section dropped the restart.
  const lastSectPr = lastSectPrIndex(documentXml);
  const scope = lastSectPr === -1 ? documentXml : documentXml.slice(lastSectPr);
  const match = /<w:pgNumType\b[^>]*\bw:start="(\d+)"[^>]*>/.exec(scope);
  return match?.[1] ?? null;
}

/**
 * Assert that `generatedDocxBuffer`'s word/document.xml declares a page-
 * numbering restart at `expectedStartAt`. Throws VerifyRenderError (stage
 * 'report') naming the actual state found — the mismatched start value, or
 * 'not found' when no w:pgNumType element is present at all — on any
 * mismatch.
 */
export async function assertPageNumberingRestart(
  generatedDocxBuffer: Buffer,
  expectedStartAt: number
): Promise<void> {
  const documentXml = await readDocumentXml(generatedDocxBuffer);
  const actual = extractPgNumStart(documentXml);
  const expected = String(expectedStartAt);
  if (actual === expected) return;
  const found = actual === null ? 'not found' : `w:start="${actual}"`;
  throw new VerifyRenderError(
    `expected word/document.xml's trailing sectPr to carry w:pgNumType w:start="${expected}"; found ${found}`,
    { stage: 'report' }
  );
}
