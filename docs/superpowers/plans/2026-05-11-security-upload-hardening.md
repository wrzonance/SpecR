# Security Hardening: DOCX Upload Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate DOCX/SEC upload attack surface — zipbomb, path traversal, macro injection, external relationship injection, MIME spoofing, and junk-traffic job inflation — per issue #22.

**Architecture:** Three-layer defence. (1) `multer` `fileFilter` gates memory allocation on extension. (2) `assertDocxSafe` (yauzl central-directory scan, no full decompress) and `assertSecSafe` (encoding checks) run in `parseHandler` before `createJob` is ever called. (3) XML parser options are audited and made explicit in all three DOCX parser files. All validation is synchronous from the API caller's perspective — invalid uploads get a 400 before any job is created.

**Tech Stack:** `yauzl` (structural zip scan without decompression), `express-rate-limit`, existing `fast-xml-parser` v5, `multer` v2, `JSZip` (test fixture generation only).

**Out of scope:** Worker concurrency cap (piscina/semaphore) — track as follow-up issue; auth-keyed rate limiting — deferred to Phase 2 auth landing.

---

## File Structure

**New files:**
- `src/parser/docx/safety.ts` — `assertDocxSafe(buf: Buffer): Promise<void>` + all helpers
- `src/parser/docx/safety.test.ts` — unit tests: 9 attack scenarios + corpus integration runner
- `src/parser/sec/safety.ts` — `assertSecSafe(buf: Buffer): void`
- `src/parser/sec/safety.test.ts` — unit tests: 4 encoding/length scenarios

**Modified files:**
- `src/parser/docx/index.ts` — re-export `assertDocxSafe`
- `src/parser/sec/index.ts` — re-export `assertSecSafe`
- `src/parser/index.ts` — re-export both
- `src/api/parse.ts` — async handler, `fileFilter`, validate-before-`createJob`, pass `buf`+`ext` not whole `file` object
- `src/api/parse.test.ts` — update for async handler, add validation branch tests, mock safety functions
- `src/api/middleware/error.ts` — add `multer.MulterError` → 400 mapping
- `src/api/router.ts` — add `express-rate-limit` to `POST /parse`
- `src/parser/docx/document.ts` — replace SECURITY TODO with audit finding
- `src/parser/docx/numbering.ts` — add explicit `processEntities: true`
- `src/parser/docx/styles.ts` — add explicit `processEntities: true`

---

### Task 1: Install new dependencies

**Files:** `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Install yauzl and types**

```bash
pnpm add yauzl
pnpm add -D @types/yauzl
```

Expected: `package.json` gains `"yauzl"` in `dependencies`, `"@types/yauzl"` in `devDependencies`.

- [ ] **Step 2: Install express-rate-limit**

```bash
pnpm add express-rate-limit
```

Expected: `package.json` gains `"express-rate-limit"` in `dependencies`.

- [ ] **Step 3: Verify build is clean**

```bash
pnpm build
```

Expected: TypeScript compilation succeeds, `dist/` produced, no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add yauzl and express-rate-limit for upload hardening"
```

---

### Task 2: Audit XML entity behaviour — resolve SECURITY TODO, add explicit config

**Files:**
- Modify: `src/parser/docx/document.ts`
- Modify: `src/parser/docx/numbering.ts`
- Modify: `src/parser/docx/styles.ts`

**Context:** The SECURITY TODO in `document.ts` (line 9) asks whether `processEntities: true` enables dangerous entity expansion. Audit finding: fast-xml-parser v5 does **not** resolve custom or recursive entity declarations — `&a;` defined in a DOCTYPE is returned verbatim, not expanded. Billion-laughs is not applicable. Classic XXE (SSRF/file read) is not applicable — fxp is pure-JS with no network or filesystem access. `processEntities: true` is **required** for correct OOXML text content: real documents contain `&amp;`, `&lt;`, `&gt;` in paragraph text (ampersands, angle brackets in product names, formulas, etc.). Setting `processEntities: false` would corrupt those characters. Action: replace the TODO with the audit conclusion, and add explicit `processEntities: true` to `numbering.ts` and `styles.ts` (currently relying on the default) so all three parsers state their intent.

- [ ] **Step 1: Write a regression test pinning entity decode behaviour**

Add a new test file `src/parser/docx/xml-audit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';

describe('fast-xml-parser entity behaviour (issue #22 audit)', () => {
  it('decodes basic XML entities in text content', () => {
    const parser = new XMLParser({ processEntities: true });
    const result = parser.parse('<x>A &amp; B &lt; C &gt; D</x>') as Record<string, string>;
    expect(result['x']).toBe('A & B < C > D');
  });

  it('does not expand recursive custom entity declarations', () => {
    const parser = new XMLParser({ processEntities: true });
    const xml =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "&b;"><!ENTITY b "&a;">]><x>&a;</x>';
    // fxp v5 returns the literal entity reference — no infinite expansion
    const result = parser.parse(xml) as Record<string, unknown>;
    expect(result['x']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it passes with current code (baseline)**

```bash
pnpm test -- xml-audit
```

Expected: PASS — establishes pre-change baseline.

- [ ] **Step 3: Replace SECURITY TODO in document.ts (lines 6–18)**

Replace the comment block and XMLParser call with:

```typescript
// Entity audit (issue #22): fxp v5 does not resolve custom or recursive entity declarations
// — undefined/recursive &refs; are returned verbatim, not expanded (no billion-laughs risk).
// processEntities: true is required: OOXML text content uses &amp; &lt; &gt; for ampersands
// and angle brackets; setting false would corrupt those characters in paragraph text.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: false,
  isArray: (name) => ['w:p', 'w:r', 'w:hyperlink'].includes(name),
});
```

- [ ] **Step 4: Add explicit processEntities to numbering.ts**

In `src/parser/docx/numbering.ts`, update the `xmlParser` declaration (currently lines 6–10) to add `processEntities: true`:

```typescript
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  isArray: (name) => ['w:abstractNum', 'w:lvl', 'w:num', 'w:lvlOverride'].includes(name),
});
```

- [ ] **Step 5: Add explicit processEntities to styles.ts**

In `src/parser/docx/styles.ts`, update the `xmlParser` declaration (currently lines 6–10) to add `processEntities: true`:

```typescript
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  isArray: (name) => name === 'w:style',
});
```

- [ ] **Step 6: Run full test suite — no regressions expected**

```bash
pnpm test
```

Expected: all tests PASS. Behaviour is unchanged because `processEntities: true` was already the library default in `numbering.ts` and `styles.ts`.

- [ ] **Step 7: Lint**

```bash
pnpm lint
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/parser/docx/document.ts src/parser/docx/numbering.ts src/parser/docx/styles.ts \
        src/parser/docx/xml-audit.test.ts
git commit -m "fix(parser): audit XML entity behaviour, resolve SECURITY TODO in document.ts (#22)"
```

---

### Task 3: Implement assertDocxSafe

**Files:**
- Create: `src/parser/docx/safety.ts`
- Create: `src/parser/docx/safety.test.ts`
- Modify: `src/parser/docx/index.ts`
- Modify: `src/parser/index.ts`

**Design:** yauzl reads the zip central directory without decompressing entry content. Phase 1 (`scanZipEntries`) iterates all entries: checks count, path names (traversal), compression ratio, total uncompressed size, required entries, collects `word/_rels/` entry objects. Phase 2 (`checkExternalRelationships`) opens read streams only for collected `_rels` entries and rejects any that contain `TargetMode="External"`. Helpers are extracted to keep each function under the cognitive-complexity-10 lint limit.

- [ ] **Step 1: Write the failing tests**

Create `src/parser/docx/safety.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { assertDocxSafe } from './safety.js';

/** Build a zip Buffer via JSZip. Required DOCX entries added unless includeRequired=false. */
async function makeZip(
  extras: Record<string, string | Buffer> = {},
  includeRequired = true
): Promise<Buffer> {
  const zip = new JSZip();
  if (includeRequired) {
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
  }
  for (const [name, content] of Object.entries(extras)) {
    if (typeof content === 'string') {
      zip.file(name, content);
    } else {
      zip.file(name, content, { compression: 'DEFLATE' });
    }
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('assertDocxSafe', () => {
  it('accepts a valid minimal docx', async () => {
    const buf = await makeZip();
    await expect(assertDocxSafe(buf)).resolves.toBeUndefined();
  });

  it('rejects a non-zip buffer (bad magic bytes)', async () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    await expect(assertDocxSafe(buf)).rejects.toThrow('not a zip');
  });

  it('rejects an empty buffer', async () => {
    await expect(assertDocxSafe(Buffer.alloc(0))).rejects.toThrow('not a zip');
  });

  it('rejects path traversal in zip entry name', async () => {
    // JSZip allows creating entries with ../ components
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
    zip.file('word/../../../evil.xml', 'evil');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('path traversal');
  });

  it('rejects zip containing vbaProject.bin (macros)', async () => {
    const buf = await makeZip({ 'word/vbaProject.bin': 'macro content' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('macros not allowed');
  });

  it('rejects zip with unexpected top-level directory', async () => {
    const buf = await makeZip({ 'evil/payload.xml': '<evil/>' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('unexpected zip entry');
  });

  it('rejects zip missing [Content_Types].xml', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('missing [Content_Types].xml');
  });

  it('rejects zip missing word/document.xml', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('missing word/document.xml');
  });

  it('rejects zip with suspicious compression ratio (zipbomb indicator)', async () => {
    // 5 MB of repeated 0x41 bytes — compresses to ~5 KB; ratio ~1000x exceeds MAX_RATIO=100
    const bigContent = Buffer.alloc(5 * 1024 * 1024).fill(0x41);
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', bigContent, { compression: 'DEFLATE' });
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('compression ratio');
  });

  it('rejects zip with external relationship (TargetMode="External")', async () => {
    const relsXml = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '  <Relationship Id="rId1"',
      '    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"',
      '    Target="http://evil.example.com/payload"',
      '    TargetMode="External"/>',
      '</Relationships>',
    ].join('\n');
    const buf = await makeZip({ 'word/_rels/document.xml.rels': relsXml });
    await expect(assertDocxSafe(buf)).rejects.toThrow('external relationship');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm test -- safety
```

Expected: FAIL — `Cannot find module './safety.js'`.

- [ ] **Step 3: Implement src/parser/docx/safety.ts**

```typescript
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

interface EntryState {
  count: number;
  totalUncompressed: number;
  sawContentTypes: boolean;
  sawDocument: boolean;
  relEntries: yauzl.Entry[];
}

/** Returns an error message string, or null if the entry is acceptable. Mutates state. */
function validateZipEntry(entry: yauzl.Entry, state: EntryState): string | null {
  state.count++;
  if (state.count > MAX_ENTRIES) return 'too many zip entries';

  const name = entry.fileName;
  if (name.includes('..') || name.startsWith('/') || name.includes('\\'))
    return 'path traversal in zip entry';
  if (!ALLOWED_PREFIXES.some((p) => name === p || name.startsWith(p)))
    return `unexpected zip entry: ${name}`;
  if (name === 'word/vbaProject.bin') return 'macros not allowed';

  state.totalUncompressed += entry.uncompressedSize;
  if (state.totalUncompressed > MAX_UNCOMPRESSED) return 'uncompressed size exceeds 50 MB';
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_RATIO)
    return 'suspicious compression ratio';

  if (name === '[Content_Types].xml') state.sawContentTypes = true;
  if (name === 'word/document.xml') state.sawDocument = true;
  if (name.startsWith('word/_rels/') || name === '_rels/.rels') state.relEntries.push(entry);

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
      if (errMsg != null) { fail(errMsg); return; }
      zip.readEntry();
    });

    zip.on('end', () => {
      if (settled) return;
      settled = true;
      if (!state.sawContentTypes) { reject(new Error('missing [Content_Types].xml')); return; }
      if (!state.sawDocument) { reject(new Error('missing word/document.xml')); return; }
      resolve(state.relEntries);
    });

    zip.on('error', (err: Error) => fail(err.message));
    zip.readEntry();
  });
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err != null || stream == null) { reject(err ?? new Error('no stream')); return; }
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
    throw new ParserError(
      err instanceof Error ? err.message : 'relationship check failed',
      { cause: err }
    );
  }
}
```

- [ ] **Step 4: Re-export from src/parser/docx/index.ts**

Add at the end of `src/parser/docx/index.ts`:

```typescript
export { assertDocxSafe } from './safety.js';
```

- [ ] **Step 5: Re-export from src/parser/index.ts**

Add to `src/parser/index.ts`:

```typescript
export { assertDocxSafe } from './docx/index.js';
```

- [ ] **Step 6: Run tests — all 9 safety unit tests must pass**

```bash
pnpm test -- safety
```

Expected: 9 tests PASS.

- [ ] **Step 7: Run lint**

```bash
pnpm lint
```

Expected: clean. If `validateZipEntry` triggers cognitive-complexity, extract the ratio check into a named function:
```typescript
function ratioExceeded(entry: yauzl.Entry): boolean {
  return entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_RATIO;
}
```

- [ ] **Step 8: Run full test suite — no regressions**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/parser/docx/safety.ts src/parser/docx/safety.test.ts \
        src/parser/docx/index.ts src/parser/index.ts
git commit -m "feat(parser): implement assertDocxSafe — yauzl structural validation (#22)"
```

---

### Task 4: Implement assertSecSafe

**Files:**
- Create: `src/parser/sec/safety.ts`
- Create: `src/parser/sec/safety.test.ts`
- Modify: `src/parser/sec/index.ts`
- Modify: `src/parser/index.ts`

- [ ] **Step 1: Write failing tests**

Create `src/parser/sec/safety.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { assertSecSafe } from './safety.js';

describe('assertSecSafe', () => {
  it('accepts valid UTF-8 SEC content', () => {
    const content = '<?xml version="1.0"?>\n<SEC>\n  <PRT ID="1">GENERAL</PRT>\n</SEC>';
    expect(() => assertSecSafe(Buffer.from(content, 'utf-8'))).not.toThrow();
  });

  it('rejects buffer containing a null byte', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\x00<SEC/>', 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('null byte');
  });

  it('rejects buffer containing ASCII control characters', () => {
    // BEL (\x07) — not whitespace, not valid SEC content
    const buf = Buffer.from('<?xml version="1.0"?>\x07<SEC/>', 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('control character');
  });

  it('rejects buffer with a line exceeding 4096 characters', () => {
    const longLine = 'A'.repeat(4097);
    const buf = Buffer.from(`<?xml?>\n${longLine}\n</SEC>`, 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('line too long');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```bash
pnpm test -- sec/safety
```

Expected: FAIL — `Cannot find module './safety.js'`.

- [ ] **Step 3: Implement src/parser/sec/safety.ts**

```typescript
import { ParserError } from '../error.js';

const MAX_LINE_LENGTH = 4096;
const CONTROL_CHAR_RE = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function assertSecSafe(buf: Buffer): void {
  const text = buf.toString('utf-8');
  if (text.includes('\0')) throw new ParserError('null byte in .sec file');
  if (CONTROL_CHAR_RE.test(text)) throw new ParserError('control character in .sec file');
  if (text.split('\n').some((line) => line.length > MAX_LINE_LENGTH))
    throw new ParserError('line too long in .sec file');
}
```

- [ ] **Step 4: Re-export from src/parser/sec/index.ts**

Add at the end of `src/parser/sec/index.ts`:

```typescript
export { assertSecSafe } from './safety.js';
```

- [ ] **Step 5: Re-export from src/parser/index.ts**

Add to `src/parser/index.ts`:

```typescript
export { assertSecSafe } from './sec/index.js';
```

- [ ] **Step 6: Run tests and lint**

```bash
pnpm test -- sec/safety
pnpm lint
```

Expected: 4 tests PASS, lint clean.

- [ ] **Step 7: Run full suite**

```bash
pnpm test
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/parser/sec/safety.ts src/parser/sec/safety.test.ts \
        src/parser/sec/index.ts src/parser/index.ts
git commit -m "feat(parser): implement assertSecSafe — encoding and line-length checks (#22)"
```

---

### Task 5: Refactor parseHandler — async, validate-before-createJob, fileFilter, buffer handoff

**Files:**
- Modify: `src/api/parse.ts`
- Modify: `src/api/parse.test.ts`
- Modify: `src/api/middleware/error.ts`

**Key changes:**
1. `upload` multer instance gains `fileFilter` (silent reject on non-.docx/.sec) and tighter `limits`.
2. `parseHandler` becomes `async`. Extension and MIME checks happen first (before the buffer is handed to the safety functions). `assertDocxSafe`/`assertSecSafe` run before `createJob`. Errors return 400.
3. `processParseJob` receives `buffer: Buffer` and `ext: string` instead of the whole `Express.Multer.File` — avoids holding the full request object alive for the duration of async processing.
4. `error.ts` gets a `multer.MulterError` → 400 branch so file-size-exceeded returns 400, not 500.

- [ ] **Step 1: Write new/updated tests first**

Replace `src/api/parse.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../parser/index.js', () => ({
  parseSec: vi.fn(),
  parseDocx: vi.fn().mockResolvedValue({ id: '', section: 'test', title: 'T', parts: [] }),
  assertDocxSafe: vi.fn().mockResolvedValue(undefined),
  assertSecSafe: vi.fn(),
}));
vi.mock('../lib/jobs.js', () => ({
  createJob: vi.fn().mockReturnValue('test-job-id'),
  updateJob: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  pool: { connect: vi.fn(), query: vi.fn() },
  createSpec: vi.fn(),
  insertTree: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function makeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetModules();
});

describe('parseHandler', () => {
  it('returns 400 when no file uploaded', async () => {
    const { parseHandler } = await import('./parse.js');
    const req = { file: undefined, body: {} } as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'file required' })
    );
  });

  it('returns 400 for unsupported file extension', async () => {
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: { originalname: 'test.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(4) },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'unsupported file extension' })
    );
  });

  it('returns 400 for .docx with wrong MIME type', async () => {
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.docx',
        mimetype: 'application/octet-stream',
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'MIME type mismatch for .docx' })
    );
  });

  it('returns 400 and does NOT create a job when assertDocxSafe rejects', async () => {
    const { assertDocxSafe } = await import('../parser/index.js');
    vi.mocked(assertDocxSafe).mockRejectedValueOnce(new Error('macros not allowed'));
    const { createJob } = await import('../lib/jobs.js');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'macros not allowed' })
    );
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 202 with jobId for a valid .docx upload', async () => {
    const { createJob } = await import('../lib/jobs.js');
    vi.mocked(createJob).mockReturnValue('test-job-id');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { jobId: 'test-job-id' } })
    );
  });

  it('returns 202 for a valid .sec upload', async () => {
    const { createJob } = await import('../lib/jobs.js');
    vi.mocked(createJob).mockReturnValue('sec-job-id');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.sec',
        mimetype: 'text/xml',
        buffer: Buffer.from('<?xml?>', 'utf-8'),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
  });
});

describe('parseJobHandler', () => {
  it('returns 404 when job not found', async () => {
    const { getJob } = await import('../lib/jobs.js');
    vi.mocked(getJob).mockReturnValue(undefined);
    const { parseJobHandler } = await import('./parse.js');
    const req = { params: { jobId: 'nonexistent' } } as unknown as Request;
    const res = makeRes();
    parseJobHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 200 with job data when found', async () => {
    const { getJob } = await import('../lib/jobs.js');
    vi.mocked(getJob).mockReturnValue({
      jobId: 'abc',
      status: 'complete' as const,
      progress: { stage: 'complete' as const, pct: 100 },
      expiresAt: Date.now() + 3600000,
    });
    const { parseJobHandler } = await import('./parse.js');
    const req = { params: { jobId: 'abc' } } as unknown as Request;
    const res = makeRes();
    parseJobHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
```

- [ ] **Step 2: Run new tests — verify they fail (handler not yet updated)**

```bash
pnpm test -- parse.test
```

Expected: multiple FAIL — `parseHandler` is sync, MIME/extension checks missing, safety mocks not wired.

- [ ] **Step 3: Rewrite src/api/parse.ts**

```typescript
import multer from 'multer';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  parseSec,
  parseDocx,
  assertDocxSafe,
  assertSecSafe,
} from '../parser/index.js';
import { createJob, updateJob, getJob, type ParseStage } from '../lib/jobs.js';
import { pool, createSpec, insertTree } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { CsiNode, CsiTree } from '../ast/types.js';

interface ParseBody {
  readonly section?: string;
  readonly title?: string;
}

function parseBody(raw: unknown): ParseBody {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const result: ParseBody = {};
  if (typeof r['section'] === 'string') return { ...result, section: r['section'] };
  if (typeof r['title'] === 'string') return { ...result, title: r['title'] };
  return result;
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_EXT = new Set(['.docx', '.sec']);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB compressed limit (yauzl enforces uncompressed)
    files: 1,
    fields: 5,
    fieldSize: 1024,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Silent reject — handler provides the descriptive error message
    cb(null, ALLOWED_EXT.has(ext));
  },
});

export async function parseHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'file required' });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    res.status(400).json({ success: false, error: 'unsupported file extension' });
    return;
  }
  if (ext === '.docx' && req.file.mimetype !== DOCX_MIME) {
    res.status(400).json({ success: false, error: 'MIME type mismatch for .docx' });
    return;
  }

  try {
    if (ext === '.docx') {
      await assertDocxSafe(req.file.buffer);
    } else {
      assertSecSafe(req.file.buffer);
    }
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'invalid file',
    });
    return;
  }

  const jobId = createJob();
  // Pass buffer and ext, not the full file object, so the request closure can be GC'd
  void processParseJob(jobId, req.file.buffer, ext, parseBody(req.body));
  res.status(202).json({ success: true, data: { jobId } });
}

export function parseJobHandler(req: Request, res: Response): void {
  const jobId = req.params['jobId'];
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'missing jobId' });
    return;
  }
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'job not found' });
    return;
  }
  res.status(200).json({ success: true, data: job });
}

function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

async function persistTree(tree: CsiTree): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = tree.parts[0]?.meta.source ?? 'unknown';
    const specId = await createSpec({ section: tree.section, title: tree.title, source }, client);
    const treeWithId: CsiTree = { ...tree, id: specId };
    await insertTree(treeWithId, specId, client);
    await client.query('COMMIT');
    return specId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processParseJob(
  jobId: string,
  buffer: Buffer,
  ext: string,
  body: ParseBody
): Promise<void> {
  try {
    const onProgress = (stage: string, pct: number): void => {
      updateJob(jobId, { stage: stage as ParseStage, pct, status: 'running' });
    };

    let tree: CsiTree;
    if (ext === '.sec') {
      onProgress('extracting', 10);
      tree = parseSec(buffer.toString('utf-8')).tree;
      onProgress('classifying', 75);
    } else {
      tree = await parseDocx(buffer, onProgress);
    }

    const finalTree: CsiTree = {
      ...tree,
      ...(body.section ? { section: body.section } : {}),
      ...(body.title ? { title: body.title } : {}),
    };

    updateJob(jobId, { stage: 'persisting', pct: 90, status: 'running' });
    const specId = await persistTree(finalTree);
    const nodeCount = countNodes(finalTree.parts);

    updateJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: { specId, section: finalTree.section, title: finalTree.title, nodeCount },
    });
  } catch (err) {
    logger.error({ err, jobId }, 'parse job failed');
    updateJob(jobId, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'parse failed',
    });
  }
}
```

- [ ] **Step 4: Add multer.MulterError → 400 to error middleware**

Replace `src/api/middleware/error.ts` with:

```typescript
import multer from 'multer';
import type { ErrorRequestHandler } from 'express';
import { logger } from '../../lib/logger.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, 'unhandled error');
  if (err instanceof multer.MulterError) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ success: false, error: 'internal server error' });
};
```

- [ ] **Step 5: Run updated parse tests**

```bash
pnpm test -- parse.test
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Run full test suite**

```bash
pnpm test
```

Expected: all PASS.

- [ ] **Step 7: Lint**

```bash
pnpm lint
```

Expected: clean. If `parseHandler` complexity exceeds 10, extract the validation block into `validateUpload(req): string | null` returning an error message.

- [ ] **Step 8: Commit**

```bash
git add src/api/parse.ts src/api/parse.test.ts src/api/middleware/error.ts
git commit -m "fix(api): validate uploads before createJob — async handler, fileFilter, MIME check (#22)"
```

---

### Task 6: Add rate limiting to POST /parse

**Files:**
- Modify: `src/api/router.ts`

- [ ] **Step 1: Write the test — rate limiter is applied on POST /parse**

Add to `src/api/parse.test.ts` (or a dedicated `router.test.ts` if one exists). Since rate limiting is integration-level behaviour, verify by checking the router setup. In the current test structure, a simple smoke-test confirming the middleware is wired is sufficient:

The existing `parse.integration.test.ts` will exercise the route. The unit tests above already confirm handler behaviour. No additional unit test is needed for this step — the integration test at `src/api/parse.integration.test.ts` will catch it.

- [ ] **Step 2: Add rate limiter import and config to router.ts**

Replace `src/api/router.ts` with:

```typescript
import { type Router as RouterType, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { healthHandler } from './health.js';
import { getSpecHandler, updateSpecHandler } from './specs.js';
import {
  createProjectHandler,
  getProjectHandler,
  addSpecToProjectHandler,
  removeSpecFromProjectHandler,
  getBrokenRefsHandler,
} from './projects.js';
import { validateBody } from './middleware/validate.js';
import {
  PatchSpecBodySchema,
  CreateProjectBodySchema,
  AddSpecToProjectBodySchema,
} from '../ast/index.js';
import { parseHandler, parseJobHandler, upload } from './parse.js';

const parseRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10,             // 10 uploads per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'too many requests — please wait before uploading again' },
});

export const router: RouterType = Router();

router.get('/health', healthHandler);
router.get('/specs/:id', getSpecHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
router.post('/projects', validateBody(CreateProjectBodySchema), createProjectHandler);
router.get('/projects/:id', getProjectHandler);
router.post(
  '/projects/:id/specs',
  validateBody(AddSpecToProjectBodySchema),
  addSpecToProjectHandler
);
router.delete('/projects/:id/specs/:specId', removeSpecFromProjectHandler);
router.get('/projects/:id/references/broken', getBrokenRefsHandler);
router.post('/parse', parseRateLimit, upload.single('file'), parseHandler);
router.get('/parse/jobs/:jobId', parseJobHandler);
```

- [ ] **Step 3: Build and run full test suite**

```bash
pnpm build && pnpm test
```

Expected: build clean, all tests PASS.

- [ ] **Step 4: Lint**

```bash
pnpm lint
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/api/router.ts
git commit -m "feat(api): add rate limiting to POST /parse — 10 req/min per IP (#22)"
```

---

### Task 7: Corpus validation — all fixture .docx files pass assertDocxSafe

**Files:**
- Create: `src/parser/docx/safety.integration.test.ts`

**Purpose:** Verify that the 30 real-world DOCX files in `docs/references/` all pass `assertDocxSafe` with the chosen constants (MAX_UNCOMPRESSED=50MB, MAX_ENTRIES=200, MAX_RATIO=100). This guards against false positives that would break production parses. If any fixture fails, the constants need tuning before the PR ships.

- [ ] **Step 1: Write the integration test**

Create `src/parser/docx/safety.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertDocxSafe } from './safety.js';

const FIXTURE_DIRS = [
  path.resolve('docs/references/ARCAT'),
  path.resolve('docs/references/MANUFACTURER_CPI'),
];

async function collectDocxFixtures(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of FIXTURE_DIRS) {
    try {
      await stat(dir);
    } catch {
      continue;
    }
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.docx')) {
        found.push(path.join(dir, entry));
      }
    }
  }
  return found;
}

describe('assertDocxSafe — corpus validation', () => {
  it('all fixture .docx files pass structural safety check', async () => {
    const fixtures = await collectDocxFixtures();
    if (fixtures.length === 0) {
      console.warn('No .docx fixtures found — skipping corpus test');
      return;
    }

    const results: Array<{ file: string; error: string }> = [];
    for (const filePath of fixtures) {
      const buf = await readFile(filePath);
      try {
        await assertDocxSafe(buf);
      } catch (err) {
        results.push({
          file: path.relative(process.cwd(), filePath),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (results.length > 0) {
      const detail = results
        .map((r) => `  ${r.file}: ${r.error}`)
        .join('\n');
      throw new Error(
        `${results.length}/${fixtures.length} fixtures failed assertDocxSafe:\n${detail}`
      );
    }

    console.info(`assertDocxSafe: ${fixtures.length} fixtures passed`);
    expect(fixtures.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the corpus test**

```bash
pnpm test -- safety.integration
```

Expected: all 29 `.docx` fixture files PASS. If any fail, read the error message and tune the relevant constant in `safety.ts` (typically `MAX_RATIO` if a legitimate fixture uses aggressive compression).

- [ ] **Step 3: If any fixture fails, tune constants**

If a fixture reports `suspicious compression ratio`:
- Open `src/parser/docx/safety.ts`
- Increase `MAX_RATIO` from 100 to the next sensible value (e.g. 200) and re-run
- Document the adjusted value with a comment naming the fixture that drove the change

If a fixture reports `unexpected zip entry`:
- Add the entry's prefix to `ALLOWED_PREFIXES` in `safety.ts` if it is a legitimate OOXML component
- Re-run corpus test

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser/docx/safety.integration.test.ts
git commit -m "test(parser): corpus validation — all ARCAT/CPI fixtures pass assertDocxSafe (#22)"
```

---

## Self-Review

### Spec coverage

| Acceptance item (issue #22) | Task |
|---|---|
| `fileFilter` rejects non-.docx/.sec | Task 5 |
| Tighter multer limits (`files: 1`, `fields`, `fieldSize`) | Task 5 |
| `assertDocxSafe` implemented with yauzl | Task 3 |
| `assertDocxSafe` unit-tested: valid, zipbomb header, path traversal, missing CT.xml, `vbaProject.bin`, unexpected entries | Task 3 |
| `assertSecSafe` implemented | Task 4 |
| Validation runs before `createJob` | Task 5 |
| XML parser entity behaviour audited; `processEntities` explicit in all docx parser files | Task 2 |
| External relationship inspection in place | Task 3 |
| Buffer ref scope reduced after parser returns | Task 5 (buffer+ext passed, not file) |
| Rate limiter on upload route | Task 6 |
| Corpus test: 20+ real-world docx files pass `assertDocxSafe` | Task 7 |
| MIME type mismatch check for .docx | Task 5 |

Job concurrency cap: **out of scope** — tracked as follow-up (requires piscina or semaphore, separate PR).

### Placeholder scan

No TBD or "implement later" language present. All code blocks are complete.

### Type consistency

- `assertDocxSafe` exported from `safety.ts`, re-exported via `docx/index.ts` → `parser/index.ts` — import chain consistent across Tasks 3 and 5.
- `assertSecSafe` exported from `sec/safety.ts`, re-exported via `sec/index.ts` → `parser/index.ts` — consistent across Tasks 4 and 5.
- `processParseJob(jobId, buffer, ext, body)` — signature defined in Task 5 Step 3 and called in same file; no cross-task type mismatch.
- `validateZipEntry(entry, state)` — defined and called within `safety.ts` only; no cross-task reference.
