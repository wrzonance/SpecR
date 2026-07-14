// JSZip glob-read I/O for header/footer parts (#306, ADR-068). Word numbers
// header/footer parts arbitrarily (header1.xml, header2.xml, ... often
// non-sequential, sometimes sparse) — this module makes no fixed-name
// assumption, discovering every word/header*.xml and word/footer*.xml part
// via JSZip's regex .file() form. Isolated as its own I/O helper — not
// inlined into index.ts's extractEntries — so extractEntries stays under
// eslint's 50-line function cap (ADR-068 spike finding #1).

import type JSZip from 'jszip';

export interface HeaderFooterParts {
  readonly headerParts: ReadonlyMap<string, string>;
  readonly footerParts: ReadonlyMap<string, string>;
}

// Anchored to word/ and a trailing digit run so a part-styling or reference
// file that merely contains "header"/"footer" in its name (e.g.
// word/header-styles.xml, word/headerReference.xml) is never mistaken for an
// actual header/footer part, and a same-named part outside word/ (e.g. a
// customXml part) is never picked up.
const HEADER_PART_PATTERN = /^word\/header\d+\.xml$/;
const FOOTER_PART_PATTERN = /^word\/footer\d+\.xml$/;

async function readParts(zip: JSZip, pattern: RegExp): Promise<ReadonlyMap<string, string>> {
  const matches = zip.file(pattern);
  const entries = await Promise.all(
    matches.map(async (file) => [file.name, await file.async('string')] as const)
  );
  return new Map(entries);
}

/**
 * Glob-discover and read every word/header*.xml and word/footer*.xml part in
 * the archive. Keyed by full zip path (e.g. "word/header1.xml") — the same
 * shape resolveReferenceTargets (header-footer-relationships.ts) resolves a
 * relationship target to, so callers can look a resolved reference's content
 * up directly. A document with no headers/footers yields empty maps, never a
 * throw — that is not an error, just the common case.
 */
export async function readHeaderFooterParts(zip: JSZip): Promise<HeaderFooterParts> {
  const [headerParts, footerParts] = await Promise.all([
    readParts(zip, HEADER_PART_PATTERN),
    readParts(zip, FOOTER_PART_PATTERN),
  ]);
  return { headerParts, footerParts };
}
