// Eagerly resolves the image-relationship media bytes referenced by every
// header/footer part's own .rels file (#487, ADR-068/069/071). Self-contained
// glob over word/_rels/header*.xml.rels and word/_rels/footer*.xml.rels —
// mirrors header-footer-parts.ts's glob style, with no dependency on that
// module's output, so both run side-by-side in index.ts's extractEntries
// Promise.all batch. Fully resolved here, in the async extraction phase,
// before header-footer.ts's synchronous capture pass runs — sync capture
// never awaits I/O for images.

import type JSZip from 'jszip';
import { ParserError } from '../error.js';
import { parseImageRelationships } from './header-footer-relationships.js';

/**
 * Media bytes for every image relationship declared in a header/footer
 * part's own .rels file, keyed first by the owning part's full zip path
 * (e.g. "word/header1.xml" — the same key header-footer.ts's partXmlFor
 * uses), then by relationship id (rId). A part absent from this map, or an
 * rId absent from a part's inner map, both mean "no media for that
 * reference" — never an error. Callers (header-footer-images.ts's
 * resolveDrawingImage) treat both cases identically: fall back to the
 * unmodeled/raw-sidecar arm.
 */
export type HeaderFooterMediaByPart = ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;

// Same anchoring rationale as header-footer-parts.ts's HEADER_PART_PATTERN /
// FOOTER_PART_PATTERN: word/-rooted and digit-terminated so a same-shaped but
// unrelated .rels file (e.g. word/_rels/header-styles.xml.rels) is never
// mistaken for an actual header/footer part's relationships.
const HEADER_RELS_PATTERN = /^word\/_rels\/header\d+\.xml\.rels$/;
const FOOTER_RELS_PATTERN = /^word\/_rels\/footer\d+\.xml\.rels$/;

// OPC convention: a part's .rels file lives in a _rels/ subfolder beside it,
// named <part-filename>.rels. word/_rels/header1.xml.rels -> word/header1.xml.
function ownerPartPath(relsPath: string): string {
  return relsPath.replace(/^word\/_rels\//, 'word/').replace(/\.rels$/, '');
}

// One rId's bytes, or undefined when the declared target is missing from the
// archive. Never throws for a missing target — that is "no media", not an
// error; a rejected fetch (corrupt/undecompressable entry) is left to the
// caller's Promise.allSettled to isolate.
async function readMediaBytes(zip: JSZip, target: string): Promise<Uint8Array | undefined> {
  const file = zip.file(target);
  if (!file) return undefined;
  const buffer = await file.async('nodebuffer');
  return new Uint8Array(buffer);
}

// Resolves one header/footer part's declared image relationships to bytes.
// Per-entry fault isolation via Promise.allSettled (never a bare Promise.all)
// — one rId's rejected/missing fetch never prevents a sibling rId in the same
// part from being captured. Structural failures of the .rels part itself are a
// different failure mode and are NOT isolated here: a corrupt/undecompressable
// .rels entry (relsFile.async) and a malformed .rels XML SYNTAX
// (parseImageRelationships) both surface as a typed ParserError — matching
// parseImageRelationships's own documented contract and this codebase's
// module-boundary rule (no raw JSZip error escapes this parser surface).
async function readPartMedia(
  zip: JSZip,
  relsFile: JSZip.JSZipObject
): Promise<readonly [string, ReadonlyMap<string, Uint8Array>]> {
  const partPath = ownerPartPath(relsFile.name);
  let relsXml: string;
  try {
    relsXml = await relsFile.async('string');
  } catch (err) {
    throw new ParserError(`failed to read header/footer relationships part ${relsFile.name}`, {
      code: 'DOCX_HEADER_FOOTER_XML_INVALID',
      cause: err,
    });
  }
  const imageRels = parseImageRelationships(relsXml, partPath);

  const settled = await Promise.allSettled(
    [...imageRels].map(async ([rId, target]) => [rId, await readMediaBytes(zip, target)] as const)
  );

  const media = new Map<string, Uint8Array>();
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value[1] !== undefined) {
      media.set(result.value[0], result.value[1]);
    }
  }
  return [partPath, media];
}

async function readMediaForPattern(
  zip: JSZip,
  pattern: RegExp
): Promise<readonly (readonly [string, ReadonlyMap<string, Uint8Array>])[]> {
  const relsFiles = zip.file(pattern);
  return Promise.all(relsFiles.map((relsFile) => readPartMedia(zip, relsFile)));
}

/**
 * Glob-discover every header/footer part's own .rels file, resolve its image
 * relationships, and eagerly fetch each referenced target's bytes. Runs
 * fully in the async extraction phase (index.ts's extractEntries) so
 * header-footer.ts's synchronous capture pass never awaits I/O. A document
 * with no header/footer image relationships yields an empty map, never a
 * throw — that is the common case, not an error.
 */
export async function readHeaderFooterMedia(zip: JSZip): Promise<HeaderFooterMediaByPart> {
  const [headerEntries, footerEntries] = await Promise.all([
    readMediaForPattern(zip, HEADER_RELS_PATTERN),
    readMediaForPattern(zip, FOOTER_RELS_PATTERN),
  ]);
  return new Map([...headerEntries, ...footerEntries]);
}
