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

interface EntryState {
  count: number;
  totalUncompressed: number;
  sawContentTypes: boolean;
  sawDocument: boolean;
  relEntries: yauzl.Entry[];
}

function checkNameAndType(name: string): string | null {
  if (hasDangerousPath(name)) return 'path traversal in zip entry';
  if (!isAllowedEntry(name)) return `unexpected zip entry: ${name}`;
  if (name === 'word/vbaProject.bin') return 'macros not allowed';
  return null;
}

function checkSizeConstraints(entry: yauzl.Entry, state: EntryState): string | null {
  state.totalUncompressed += entry.uncompressedSize;
  if (state.totalUncompressed > MAX_UNCOMPRESSED) return 'uncompressed size exceeds 50 MB';
  if (ratioExceeded(entry)) return 'suspicious compression ratio';
  return null;
}

function updateRequiredFlags(entry: yauzl.Entry, state: EntryState): void {
  const { fileName } = entry;
  if (fileName === '[Content_Types].xml') state.sawContentTypes = true;
  if (fileName === 'word/document.xml') state.sawDocument = true;
  if (fileName.startsWith('word/_rels/') || fileName === '_rels/.rels')
    state.relEntries.push(entry);
}

/** Returns an error message string, or null if the entry is acceptable. Mutates state. */
function validateZipEntry(entry: yauzl.Entry, state: EntryState): string | null {
  state.count++;
  if (state.count > MAX_ENTRIES) return 'too many zip entries';

  const nameErr = checkNameAndType(entry.fileName);
  if (nameErr != null) return nameErr;

  const sizeErr = checkSizeConstraints(entry, state);
  if (sizeErr != null) return sizeErr;

  updateRequiredFlags(entry, state);
  return null;
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
    const state: EntryState = {
      count: 0,
      totalUncompressed: 0,
      sawContentTypes: false,
      sawDocument: false,
      relEntries: [],
    };
    let settled = false;

    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(msg));
    };

    zip.on('entry', (entry: yauzl.Entry) => {
      if (settled) return;
      const errMsg = validateZipEntry(entry, state);
      if (errMsg != null) {
        fail(errMsg);
        return;
      }
      zip.readEntry();
    });

    zip.on('end', () => {
      if (settled) return;
      settled = true;
      if (!state.sawContentTypes) {
        reject(new Error('missing [Content_Types].xml'));
        return;
      }
      if (!state.sawDocument) {
        reject(new Error('missing word/document.xml'));
        return;
      }
      resolve(state.relEntries);
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

function hasExternalTarget(xml: string): boolean {
  return /TargetMode\s*=\s*["']External["']/i.test(xml);
}

/** Phase 2: open read streams for _rels entries; reject if TargetMode="External" found. */
async function checkExternalRelationships(
  zip: yauzl.ZipFile,
  relEntries: readonly yauzl.Entry[]
): Promise<void> {
  for (const entry of relEntries) {
    const content = await readZipEntry(zip, entry);
    if (hasExternalTarget(content)) {
      throw new Error(`external relationship in ${entry.fileName}`);
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
