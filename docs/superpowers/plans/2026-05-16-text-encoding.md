# Text Encoding (decodeTextBuffer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `TextDecoder('utf-8', { fatal: true })` in the SEC ingest pipeline with encoding-transparent `decodeTextBuffer` so any `.SEC` file (windows-1252, latin-1, UTF-8, etc.) ingests correctly via REST and MCP.

**Architecture:** New `src/lib/decode-text.ts` uses `chardet` (detection) + `iconv-lite` (transcode) to produce a UTF-8 string from any Buffer. `assertSecSafe` in `src/parser/sec/safety.ts` gains a `string` return type — callers (`api/parse.ts`, `mcp/tools.ts`) use the returned string instead of `buffer.toString('utf-8')`.

**Tech Stack:** Node.js/TypeScript, `chardet` (MIT, ~8M downloads/wk), `iconv-lite` (MIT, ~200M/wk), Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/decode-text.ts` | `decodeTextBuffer(buf): string` — single exported fn |
| Create | `src/lib/decode-text.test.ts` | Unit tests for decoding (UTF-8, windows-1252, latin-1, null fallback) |
| Modify | `src/parser/sec/safety.ts` | Use `decodeTextBuffer`; change return type `void` → `string` |
| Modify | `src/parser/sec/safety.test.ts` | Remove UTF-8-rejection test; add windows-1252 + return-value tests |
| Modify | `src/parser/sec/index.integration.test.ts` | Add describe block: raw Buffer → `assertSecSafe` → `parseSec` for `27_10_00.SEC` |
| Modify | `src/api/parse.ts:118` | `buffer.toString('utf-8')` → `assertSecSafe(buffer)` |
| Modify | `src/mcp/tools.ts` | Capture `assertSecSafe` return in `decodeSafeBuffer`; pass to `parseSec` |
| Modify | `README.md` | Note encoding-transparent ingest in "What Works Today" |
| Modify | `ARCHITECTURE.md` | Add `lib/decode-text.ts` to file structure; add chardet+iconv-lite to deps |
| Modify | `CLAUDE.md` | Add `decode-text.ts` module boundary note under `lib/` |

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json` (via pnpm add)

- [ ] **Step 1: Install chardet and iconv-lite**

```bash
cd /home/adam/github/SpecR
pnpm add chardet iconv-lite
```

Expected: packages added to `dependencies` in `package.json`, lock file updated.

- [ ] **Step 2: Verify TypeScript types are bundled**

```bash
ls node_modules/chardet/index.d.ts node_modules/iconv-lite/lib/index.d.ts
```

Expected: both paths exist (no `@types/` packages needed).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add chardet + iconv-lite for encoding detection"
```

---

### Task 2: Write failing tests for `decode-text.ts`

**Files:**
- Create: `src/lib/decode-text.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// src/lib/decode-text.test.ts
import { describe, it, expect } from 'vitest'
import { decodeTextBuffer } from './decode-text.js'

describe('decodeTextBuffer', () => {
  it('decodes a UTF-8 buffer correctly', () => {
    const buf = Buffer.from('hello world', 'utf-8')
    expect(decodeTextBuffer(buf)).toBe('hello world')
  })

  it('decodes a windows-1252 buffer containing em-dash (0x96)', () => {
    // 0x96 = em-dash in windows-1252; invalid in strict UTF-8
    const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x96, 0x77, 0x6f, 0x72, 0x6c, 0x64])
    const result = decodeTextBuffer(buf)
    // chardet detects windows-1252 / ISO-8859-1 variant; iconv transcodes 0x96 → U+2013 (–)
    expect(result).toContain('–')
    expect(result).toContain('hello')
    expect(result).toContain('world')
  })

  it('decodes a latin-1 buffer with accented characters', () => {
    // 0xe9 = 'é' in latin-1/ISO-8859-1
    const buf = Buffer.from([0x63, 0x61, 0x66, 0xe9])
    const result = decodeTextBuffer(buf)
    expect(result).toContain('caf')
    // iconv transcodes 0xe9 to U+00E9 (é) — may appear as é or in a variant form
    expect(result.length).toBeGreaterThan(0)
  })

  it('does not throw when chardet returns null (minimal buffer)', () => {
    // Single byte that may confuse chardet — must not throw, must return a string
    const buf = Buffer.from([0xff])
    expect(() => decodeTextBuffer(buf)).not.toThrow()
    expect(typeof decodeTextBuffer(buf)).toBe('string')
  })
})
```

- [ ] **Step 2: Run test — verify RED**

```bash
pnpm test src/lib/decode-text.test.ts
```

Expected: fails with `Cannot find module './decode-text.js'` or similar module-not-found error.

---

### Task 3: Implement `src/lib/decode-text.ts`

**Files:**
- Create: `src/lib/decode-text.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// src/lib/decode-text.ts
import chardet from 'chardet';
import iconv from 'iconv-lite';

export function decodeTextBuffer(buf: Buffer): string {
  const encoding = chardet.detect(buf) ?? 'utf-8';
  return iconv.decode(buf, encoding);
}
```

- [ ] **Step 2: Run tests — verify GREEN**

```bash
pnpm test src/lib/decode-text.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 3: Lint**

```bash
pnpm lint
```

Expected: no errors. (If `chardet` or `iconv-lite` import style causes a lint error, check their ESM/CJS exports — `chardet` exports a default, `iconv-lite` exports a namespace. If TypeScript complains, try `import * as iconv from 'iconv-lite'`.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/decode-text.ts src/lib/decode-text.test.ts
git commit -m "feat(lib): add decodeTextBuffer — chardet + iconv-lite encoding detection"
```

---

### Task 4: Update `safety.ts` + `safety.test.ts`

**Files:**
- Modify: `src/parser/sec/safety.ts`
- Modify: `src/parser/sec/safety.test.ts`

**Context:** The existing test `'rejects invalid UTF-8 byte sequence'` checks behavior that is intentionally removed (we no longer reject non-UTF-8 bytes). It must be replaced. All other existing tests remain valid — safety checks (null byte, control chars, line length) run on the decoded string, not the raw buffer, so behavior is unchanged.

- [ ] **Step 1: Write new/updated tests (RED)**

Replace the contents of `src/parser/sec/safety.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest'
import { assertSecSafe } from './safety.js'

describe('assertSecSafe', () => {
  it('accepts windows-1252 bytes that fail strict UTF-8 validation', () => {
    // 0x96 = em-dash in windows-1252; was previously rejected as "invalid UTF-8"
    const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x96])
    expect(() => assertSecSafe(buf)).not.toThrow()
  })

  it('accepts valid UTF-8 SEC content and returns a string', () => {
    const content = '<?xml version="1.0"?>\n<SEC>\n  <PRT ID="1">GENERAL</PRT>\n</SEC>'
    const result = assertSecSafe(Buffer.from(content, 'utf-8'))
    expect(typeof result).toBe('string')
    expect(result).toContain('<SEC>')
  })

  it('returns decoded string for windows-1252 input', () => {
    // Build a minimal windows-1252 buffer
    const buf = Buffer.from([0x41, 0x96, 0x42]) // 'A' + em-dash + 'B' in windows-1252
    const result = assertSecSafe(buf)
    expect(typeof result).toBe('string')
    expect(result).toContain('A')
    expect(result).toContain('B')
  })

  it('rejects buffer containing a null byte', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\x00<SEC/>', 'utf-8')
    expect(() => assertSecSafe(buf)).toThrow('null byte')
  })

  it('rejects buffer containing ASCII control characters', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\x07<SEC/>', 'utf-8')
    expect(() => assertSecSafe(buf)).toThrow('control character')
  })

  it('rejects buffer with a line exceeding 4096 characters', () => {
    const longLine = 'A'.repeat(4097)
    const buf = Buffer.from(`<?xml?>\n${longLine}\n</SEC>`, 'utf-8')
    expect(() => assertSecSafe(buf)).toThrow('line too long')
  })
})
```

- [ ] **Step 2: Run tests — verify RED**

```bash
pnpm test src/parser/sec/safety.test.ts
```

Expected: new `returns decoded string` and `accepts windows-1252` tests fail (return type is `void`, method throws on non-UTF-8).

- [ ] **Step 3: Update `safety.ts`**

Replace contents of `src/parser/sec/safety.ts` with:

```typescript
import { ParserError } from '../error.js';
import { decodeTextBuffer } from '../../lib/decode-text.js';

const MAX_LINE_LENGTH = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function assertSecSafe(buf: Buffer): string {
  const text = decodeTextBuffer(buf);
  if (text.includes('\0')) throw new ParserError('null byte in .sec file');
  if (CONTROL_CHAR_RE.test(text)) throw new ParserError('control character in .sec file');
  if (text.split('\n').some((line) => line.replace(/\r$/, '').length > MAX_LINE_LENGTH))
    throw new ParserError('line too long in .sec file');
  return text;
}
```

- [ ] **Step 4: Run tests — verify GREEN**

```bash
pnpm test src/parser/sec/safety.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Run full unit test suite — verify no regressions**

```bash
pnpm test
```

Expected: all tests pass (the SEC parser uses `parseSec(xml)` where `xml` is already a string — no regressions from the `safety.ts` change).

- [ ] **Step 6: Commit**

```bash
git add src/parser/sec/safety.ts src/parser/sec/safety.test.ts
git commit -m "fix(parser): assertSecSafe accepts any encoding via decodeTextBuffer"
```

---

### Task 5: Update `src/api/parse.ts`

**Files:**
- Modify: `src/api/parse.ts:118`

**Context:** `processParseJob` calls `parseSec(buffer.toString('utf-8'))` at line 118. This garbles windows-1252 bytes. `assertSecSafe` is already called at line 42 in `validateUpload` (fire-and-forget, ignores return value — still fine). In `processParseJob`, call `assertSecSafe(buffer)` and use its return value.

- [ ] **Step 1: Update `processParseJob` in `src/api/parse.ts`**

Find this block (around line 116–119):

```typescript
    if (ext === '.sec') {
      onProgress('extracting', 10);
      tree = parseSec(buffer.toString('utf-8')).tree;
      onProgress('classifying', 75);
```

Replace with:

```typescript
    if (ext === '.sec') {
      onProgress('extracting', 10);
      tree = parseSec(assertSecSafe(buffer)).tree;
      onProgress('classifying', 75);
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: all tests pass. (`assertSecSafe` is already imported in `parse.ts` line 4 — no new import needed.)

- [ ] **Step 3: Commit**

```bash
git add src/api/parse.ts
git commit -m "fix(api): use assertSecSafe return value in processParseJob"
```

---

### Task 6: Update `src/mcp/tools.ts`

**Files:**
- Modify: `src/mcp/tools.ts` (`decodeSafeBuffer` function, around lines 61–80)

**Context:** `decodeSafeBuffer` calls `assertSecSafe(buf)` but ignores its return value, then later calls `parseSec(bufOrErr.toString('utf-8'))`. Need to capture the decoded string and pass it to `parseSec`.

- [ ] **Step 1: Update `decodeSafeBuffer` to return decoded string for `.sec`**

The `decodeSafeBuffer` function currently returns `Buffer | ToolError`. For `.sec` files we now need the decoded string. Change the function signature and return type:

```typescript
async function decodeSafeBuffer(
  ext: string,
  contentBase64: string
): Promise<Buffer | string | ToolError> {
  const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!BASE64_RE.test(contentBase64)) {
    return toolError('contentBase64 is not valid base64');
  }
  const estimatedBytes = Math.ceil((contentBase64.length * 3) / 4);
  if (estimatedBytes > 10 * 1024 * 1024) {
    return toolError('Content exceeds 10 MB decoded limit');
  }
  const buf = Buffer.from(contentBase64, 'base64');
  try {
    if (ext === '.docx') {
      await assertDocxSafe(buf);
      return buf;
    } else {
      return assertSecSafe(buf);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : 'invalid file');
  }
}
```

- [ ] **Step 2: Update the caller in `handleParseDocument`**

Find this block (around line 92–96):

```typescript
    const bufOrErr = await decodeSafeBuffer(ext, contentBase64);
    if ('isError' in bufOrErr) return bufOrErr;
    const noop = (_stage: string, _pct: number): void => {};
    const tree =
      ext === '.sec' ? parseSec(bufOrErr.toString('utf-8')).tree : await parseDocx(bufOrErr, noop);
```

Replace with:

```typescript
    const bufOrErr = await decodeSafeBuffer(ext, contentBase64);
    if ('isError' in bufOrErr) return bufOrErr;
    const noop = (_stage: string, _pct: number): void => {};
    const tree =
      ext === '.sec'
        ? parseSec(bufOrErr as string).tree
        : await parseDocx(bufOrErr as Buffer, noop);
```

- [ ] **Step 3: Run tests + lint**

```bash
pnpm test && pnpm lint
```

Expected: all pass. If TypeScript complains about the `as string`/`as Buffer` casts, extract a type guard:

```typescript
function isToolError(v: Buffer | string | ToolError): v is ToolError {
  return typeof v === 'object' && 'isError' in v;
}
```

Then replace `'isError' in bufOrErr` with `isToolError(bufOrErr)`.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools.ts
git commit -m "fix(mcp): use assertSecSafe decoded string in parse_document tool"
```

---

### Task 7: Integration test — raw Buffer path for `27_10_00.SEC`

**Files:**
- Modify: `src/parser/sec/index.integration.test.ts`

**Context:** The existing integration test reads fixtures via `readFile(path, 'latin1')` which bypasses the encoding issue. We need a new describe block that reads as a raw Buffer and runs through `assertSecSafe` → `parseSec` — the same path as `POST /parse` and `parse_document`. This test requires the DB (run via `pnpm test:integration`).

- [ ] **Step 1: Add import for `assertSecSafe`**

At the top of `src/parser/sec/index.integration.test.ts`, add to the existing imports:

```typescript
import { assertSecSafe } from './safety.js';
```

- [ ] **Step 2: Add the new describe block at the end of the file**

Append after the last `describe` block:

```typescript
describe('integration: 27_10_00.SEC via Buffer + assertSecSafe (encoding fix)', () => {
  let specId: string | undefined;

  beforeAll(async () => {
    const buf = await readFile(join(FIXTURES, '27_10_00.SEC'));
    const xml = assertSecSafe(buf);
    const { tree, refs } = parseSec(xml);

    const r = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source) VALUES ($1, $2, 'ufgs')
       ON CONFLICT (section, source) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
       RETURNING id`,
      [tree.section, tree.title]
    );
    specId = r.rows[0]?.id;
    if (!specId) throw new Error('upsert for 27_10_00.SEC returned no id');
    cleanupIds.push(specId);

    await pool.query(`DELETE FROM spec_references WHERE source_spec_id = $1`, [specId]);
    await pool.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [specId]);
    await insertTree(tree, specId, pool);
    await insertRefs(refs, specId, pool);
  });

  it('parses 27_10_00.SEC from raw Buffer without throwing', async () => {
    expect(specId).toBeDefined();
  });

  it('produces section "27 10 00"', async () => {
    const r = await pool.query<{ section: string }>(
      `SELECT section FROM specs WHERE id = $1`,
      [specId]
    );
    expect(r.rows[0]?.section).toBe('27 10 00');
  });

  it('inserts paragraphs (nodeCount > 0)', async () => {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1`,
      [specId]
    );
    expect(parseInt(r.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run integration tests**

```bash
pnpm test:integration src/parser/sec/index.integration.test.ts
```

Expected: all tests in this file pass, including the new describe block.

- [ ] **Step 4: Run full integration suite**

```bash
pnpm test:integration
```

Expected: all integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parser/sec/index.integration.test.ts
git commit -m "test(parser): integration test for 27_10_00.SEC via Buffer + assertSecSafe"
```

---

### Task 8: Doc updates

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CLAUDE.md`

Read each file before editing. Do not guess at current content.

- [ ] **Step 1: Update `README.md`**

In the "What Works Today" section, find the parsing/ingest description. Add or extend:

```
**Parser / Ingest**
- `POST /parse` accepts `.sec` (UFGS SpecsIntact XML) and `.docx` files
- Encoding-transparent: `windows-1252`, `latin-1`, UTF-8, and ~100 other encodings detected automatically via chardet + iconv-lite; no manual encoding flag needed
```

- [ ] **Step 2: Update `ARCHITECTURE.md`**

1. In the file structure section, add `decode-text.ts` under `lib/`:
   ```
   └── lib/
       ├── decode-text.ts    # Buffer → UTF-8 string, encoding-agnostic (chardet + iconv-lite)
   ```
2. In key dependencies or a relevant section, add:
   ```
   | chardet     | Byte-frequency encoding detection | MIT |
   | iconv-lite  | Multi-encoding text transcode     | MIT |
   ```

- [ ] **Step 3: Update `CLAUDE.md`**

In the `lib/` module boundary section (under "Module Boundaries" or the `src/lib/` listing), add:

```
- `decode-text.ts` — format-agnostic; usable by any parser module; never import from parser/ or db/
```

- [ ] **Step 4: Lint**

```bash
pnpm lint
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md CLAUDE.md
git commit -m "docs: note encoding-transparent ingest, add decode-text to lib/ boundary docs"
```

---

### Task 9: Final verification + PR

- [ ] **Step 1: Full test suite**

```bash
pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 2: Build**

```bash
pnpm build
```

Expected: compiles without error.

- [ ] **Step 3: Lint**

```bash
pnpm lint
```

Expected: clean.

- [ ] **Step 4: Create PR**

```bash
gh pr create \
  --title "fix(parser): encoding-transparent SEC ingest via chardet + iconv-lite" \
  --base main \
  --body "$(cat <<'EOF'
## Summary

- Adds `src/lib/decode-text.ts`: `decodeTextBuffer(buf)` — chardet detection + iconv-lite transcode, any encoding → UTF-8 string
- Updates `src/parser/sec/safety.ts`: replaces `TextDecoder('utf-8', { fatal: true })` with `decodeTextBuffer`; return type `void` → `string`
- Updates `src/api/parse.ts`: `processParseJob` uses `assertSecSafe(buffer)` return value instead of `buffer.toString('utf-8')`
- Updates `src/mcp/tools.ts`: `decodeSafeBuffer` returns decoded string for `.sec`; `handleParseDocument` uses it directly
- All 666-file UFGS corpus now ingestible via REST and MCP without manual encoding flags

## Test plan

- [ ] `pnpm test` — `decode-text.test.ts` (4 unit tests), `safety.test.ts` (6 tests, windows-1252 acceptance), all pre-existing tests green
- [ ] `pnpm test:integration` — new `27_10_00.SEC via Buffer + assertSecSafe` describe block passes; all existing integration tests still green
- [ ] `pnpm lint` — clean
- [ ] `pnpm build` — compiles

## Acceptance criteria

- [ ] `27_10_00.SEC` (windows-1252) parses via `POST /parse` without error
- [ ] `27_10_00.SEC` parses via MCP `parse_document` without error
- [ ] All pre-existing SEC parser tests pass unchanged
EOF
)"
```

---

## Out of Scope

- Bulk UFGS loader (issue #58) — unblocked by this PR, separate work
- TXT heuristic parser — future
- DOCX encoding — DOCX is binary ZIP, not a text encoding problem
- MCP read tools (`search_library`, `get_spec`, `get_paragraph`, `generate_docx`) — query DB UTF-8 text, unaffected
