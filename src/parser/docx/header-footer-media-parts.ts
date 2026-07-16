// Eagerly resolves the image-relationship media bytes referenced by every
// header/footer part's own .rels file (#487, ADR-068/069/071/#502). Self-
// contained glob over word/_rels/header*.xml.rels and
// word/_rels/footer*.xml.rels — mirrors header-footer-parts.ts's glob style,
// with no dependency on that module's output, so both run side-by-side in
// index.ts's extractEntries Promise.all batch. Fully resolved here, in the
// async extraction phase, before header-footer.ts's synchronous capture pass
// runs — sync capture never awaits I/O for images.
//
// #502: this module never throws for a damaged/malformed .rels file — a
// part whose own .rels file cannot be read or parsed degrades to a
// 'relsUnreadable' status instead of failing the whole DOCX parse. Callers
// (header-footer-images.ts, header-footer-table.ts) turn that into a typed
// unresolvedReference capture-warning instead of an unmodeled silent drop.

import type JSZip from 'jszip';
import { parseImageRelationships } from './header-footer-relationships.js';

/**
 * One header/footer part's own image-relationship media, or a marker that
 * the part's .rels file could not be read/parsed at all. `resolved` mirrors
 * the pre-#502 shape (bytes keyed by rId); `relsUnreadable` carries the
 * part's own zip path so callers can attribute a capture-warning to it.
 */
export type HeaderFooterPartMedia =
  | { readonly status: 'resolved'; readonly media: ReadonlyMap<string, Uint8Array> }
  | { readonly status: 'relsUnreadable'; readonly partPath: string };

/**
 * Per-part media state, keyed by the owning part's full zip path (e.g.
 * "word/header1.xml" — the same key header-footer.ts's partXmlFor uses). A
 * part ABSENT from this map means "no .rels file for this part at all" — the
 * common, unremarkable case, never an error. A part PRESENT means a .rels
 * file existed and was attempted: either `resolved` (with an rId absent from
 * its inner map meaning "no media for that reference"), or `relsUnreadable`
 * (the .rels file itself was corrupt/undecompressable or its XML malformed).
 * Callers (header-footer-images.ts's resolveDrawingImage,
 * header-footer-table.ts's captureTableCell) distinguish all three outcomes.
 */
export type HeaderFooterMediaByPart = ReadonlyMap<string, HeaderFooterPartMedia>;

/** Shared capture-warning reason string for a `relsUnreadable` part (#502). */
export const RELS_UNREADABLE_REASON = "header/footer part's relationships index is unreadable";

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

async function resolvePartMedia(
  zip: JSZip,
  relsFile: JSZip.JSZipObject,
  partPath: string
): Promise<ReadonlyMap<string, Uint8Array>> {
  const relsXml = await relsFile.async('string');
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
  return media;
}

// Resolves one header/footer part's declared image relationships to bytes.
// Per-entry fault isolation via Promise.allSettled (never a bare Promise.all)
// for individual rId byte fetches — one rId's rejected/missing fetch never
// prevents a sibling rId in the same part from being captured.
//
// #502: a corrupt/undecompressable .rels entry read (relsFile.async) or a
// malformed .rels XML SYNTAX (parseImageRelationships) both degrade the
// WHOLE part to `relsUnreadable` instead of throwing — this function never
// rejects. The caught error itself is discarded; the only surfaced context
// is the 'relsUnreadable' status plus partPath, which
// header-footer-media-warnings.ts turns into a per-part capture-warning
// string. This is a deliberate, narrow deviation from this codebase's usual
// "chain cause across boundaries" rule — see docs/adr/068-header-footer-
// capture-mapping.md's #502 addendum.
async function readPartMedia(
  zip: JSZip,
  relsFile: JSZip.JSZipObject
): Promise<readonly [string, HeaderFooterPartMedia]> {
  const partPath = ownerPartPath(relsFile.name);
  try {
    const media = await resolvePartMedia(zip, relsFile, partPath);
    return [partPath, { status: 'resolved', media }];
  } catch {
    return [partPath, { status: 'relsUnreadable', partPath }];
  }
}

async function readMediaForPattern(
  zip: JSZip,
  pattern: RegExp
): Promise<readonly (readonly [string, HeaderFooterPartMedia])[]> {
  const relsFiles = zip.file(pattern);
  return Promise.all(relsFiles.map((relsFile) => readPartMedia(zip, relsFile)));
}

/**
 * Glob-discover every header/footer part's own .rels file, resolve its image
 * relationships, and eagerly fetch each referenced target's bytes. Runs
 * fully in the async extraction phase (index.ts's extractEntries) so
 * header-footer.ts's synchronous capture pass never awaits I/O. A document
 * with no header/footer image relationships yields an empty map, never a
 * throw — that is the common case, not an error. A damaged .rels file
 * degrades its own part to `relsUnreadable` (#502) rather than failing the
 * whole call.
 */
export async function readHeaderFooterMedia(zip: JSZip): Promise<HeaderFooterMediaByPart> {
  const [headerEntries, footerEntries] = await Promise.all([
    readMediaForPattern(zip, HEADER_RELS_PATTERN),
    readMediaForPattern(zip, FOOTER_RELS_PATTERN),
  ]);
  return new Map([...headerEntries, ...footerEntries]);
}
