import yauzl from 'yauzl';
import { ParserError } from '../error.js';

const MAX_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB total across all entries
const MAX_ENTRIES = 200;
const MAX_RATIO = 100; // uncompressedSize / compressedSize ceiling

const ALLOWED_PREFIXES = [
  'word/',
  'docProps/',
  '_rels/',
  '[Content_Types].xml',
  'customXml/',
] as const;

function hasDocxMagicBytes(buf: Buffer): boolean {
  // PK\x03\x04 — local file header signature, first 4 bytes of every zip
  return buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304;
}

function ratioExceeded(entry: yauzl.Entry): boolean {
  return entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_RATIO;
}

function hasDangerousPath(name: string): boolean {
  return name.includes('..') || name.startsWith('/') || name.includes('\\');
}

function isAllowedEntry(name: string): boolean {
  return ALLOWED_PREFIXES.some((p) => name === p || name.startsWith(p));
}

/** Pure — checks entry name/type only, no side effects. Returns error string or null. */
function checkNameAndType(entryName: string): string | null {
  if (hasDangerousPath(entryName)) return 'path traversal in zip entry';
  if (!isAllowedEntry(entryName)) return `unexpected zip entry: ${entryName}`;
  if (entryName === 'word/vbaProject.bin') return 'macros not allowed';
  return null;
}

/** Pure — checks size/ratio. Returns new total and error string or null. */
function checkSizeConstraints(
  entry: yauzl.Entry,
  currentTotal: number
): { readonly error: string | null; readonly newTotal: number } {
  const newTotal = currentTotal + entry.uncompressedSize;
  if (newTotal > MAX_UNCOMPRESSED) return { error: 'uncompressed size exceeds 50 MB', newTotal };
  if (ratioExceeded(entry)) return { error: 'suspicious compression ratio', newTotal };
  return { error: null, newTotal };
}

interface EntryResult {
  readonly error: string | null;
  readonly newTotal: number;
  readonly isRelEntry: boolean;
  readonly sawContentTypes: boolean;
  readonly sawDocument: boolean;
}

/**
 * Pure — validates one zip entry and returns classification flags.
 * Takes current accumulator values; never mutates anything.
 */
function processEntry(entry: yauzl.Entry, count: number, totalUncompressed: number): EntryResult {
  if (count > MAX_ENTRIES)
    return {
      error: 'too many zip entries',
      newTotal: totalUncompressed,
      isRelEntry: false,
      sawContentTypes: false,
      sawDocument: false,
    };
  const nameErr = checkNameAndType(entry.fileName);
  if (nameErr != null)
    return {
      error: nameErr,
      newTotal: totalUncompressed,
      isRelEntry: false,
      sawContentTypes: false,
      sawDocument: false,
    };
  const { error: sizeErr, newTotal } = checkSizeConstraints(entry, totalUncompressed);
  if (sizeErr != null)
    return {
      error: sizeErr,
      newTotal,
      isRelEntry: false,
      sawContentTypes: false,
      sawDocument: false,
    };
  const { fileName } = entry;
  return {
    error: null,
    newTotal,
    sawContentTypes: fileName === '[Content_Types].xml',
    sawDocument: fileName === 'word/document.xml',
    isRelEntry: fileName.startsWith('word/_rels/') || fileName === '_rels/.rels',
  };
}

function openZip(buf: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err != null || zip == null) reject(err ?? new Error('zip open failed'));
      else resolve(zip);
    });
  });
}

/** Phase 1: scan the central directory without decompressing. Returns _rels entries. */
function scanZipEntries(zip: yauzl.ZipFile): Promise<readonly yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    let count = 0;
    let totalUncompressed = 0;
    let sawContentTypes = false;
    let sawDocument = false;
    const relEntries: yauzl.Entry[] = [];
    let settled = false;

    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(msg));
    };

    zip.on('entry', (entry: yauzl.Entry) => {
      if (settled) return;
      const result = processEntry(entry, ++count, totalUncompressed);
      if (result.error != null) {
        fail(result.error);
        return;
      }
      totalUncompressed = result.newTotal;
      if (result.sawContentTypes) sawContentTypes = true;
      if (result.sawDocument) sawDocument = true;
      if (result.isRelEntry) relEntries.push(entry);
      zip.readEntry();
    });

    zip.on('end', () => {
      if (settled) return;
      if (!sawContentTypes) {
        fail('missing [Content_Types].xml');
        return;
      }
      if (!sawDocument) {
        fail('missing word/document.xml');
        return;
      }
      settled = true;
      resolve(relEntries);
    });

    zip.on('error', (err: Error) => {
      const msg = err.message.includes('invalid relative path')
        ? 'path traversal in zip entry'
        : err.message;
      fail(msg);
    });
    zip.readEntry();
  });
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err != null || stream == null) {
        reject(err ?? new Error('no stream'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
  });
}

// Relationship types that trigger automatic network fetching when Word opens the document
// (SSRF / server-side request forgery vectors). Hyperlinks and images are passive — they
// only activate on user interaction — so they are intentionally excluded.
// Corpus finding: all 28 DOCX fixtures use hyperlink external rels (website URLs).
//
// attachedTemplate (settings.xml.rels) is also excluded: it is provenance metadata that
// Word writes for any document authored from a template (ubiquitous in corporate specs
// created from firm .dotm files on network shares). SpecR never dereferences relationship
// targets and discards the upload buffer after parsing, so it carries no fetch risk here —
// rejecting it blocked real-world ingest (field report 2026-06-05).
const DANGEROUS_EXTERNAL_REL_TYPES = ['externalLinkPath', 'frame', 'oleObject', 'subDocument'];

interface DangerousRel {
  readonly relType: string;
  readonly scheme: string;
}

function targetScheme(target: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1];
  if (scheme) return scheme.toLowerCase();
  return target.startsWith('\\\\') ? 'unc' : 'relative';
}

// Reports WHAT was rejected (rel type + target URL scheme) without echoing the
// target itself — proprietary documents must stay diagnosable from the error
// alone, but server names/paths in targets must not leak into messages.
function findDangerousExternalRels(xml: string): readonly DangerousRel[] {
  const found: DangerousRel[] = [];
  for (const relType of DANGEROUS_EXTERNAL_REL_TYPES) {
    const tagPattern = new RegExp(`<Relationship\\b[^>]*relationships/${relType}["'][^>]*>`, 'gi');
    for (const match of xml.matchAll(tagPattern)) {
      const tag = match[0];
      if (!/TargetMode\s*=\s*["']External["']/i.test(tag)) continue;
      const target = /Target\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
      found.push({ relType, scheme: targetScheme(target) });
    }
  }
  return found;
}

/** Phase 2: open read streams for _rels entries; reject dangerous external relationships. */
async function checkExternalRelationships(
  zip: yauzl.ZipFile,
  relEntries: readonly yauzl.Entry[]
): Promise<void> {
  for (const entry of relEntries) {
    const content = await readZipEntry(zip, entry);
    const dangerous = findDangerousExternalRels(content);
    if (dangerous.length > 0) {
      const detail = dangerous.map((d) => `${d.relType} (target scheme: ${d.scheme})`).join('; ');
      throw new Error(
        `dangerous external relationship in ${entry.fileName}: ${detail} — ` +
          'these relationship types make Word auto-fetch external content'
      );
    }
  }
}

export async function assertDocxSafe(buf: Buffer): Promise<void> {
  if (!hasDocxMagicBytes(buf)) throw new ParserError('not a zip');
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(buf);
  } catch (err) {
    throw new ParserError('invalid zip archive', { cause: err });
  }
  let relEntries: readonly yauzl.Entry[];
  try {
    relEntries = await scanZipEntries(zip);
  } catch (err) {
    throw new ParserError(err instanceof Error ? err.message : 'zip scan failed', { cause: err });
  }
  try {
    await checkExternalRelationships(zip, relEntries);
  } catch (err) {
    throw new ParserError(err instanceof Error ? err.message : 'relationship check failed', {
      cause: err,
    });
  }
}
