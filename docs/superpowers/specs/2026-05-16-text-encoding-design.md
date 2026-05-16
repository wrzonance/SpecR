# Design: Universal Text Buffer Decoding (`decodeTextBuffer`)

**Date:** 2026-05-16
**Tracking:** Unblocks issue #58 (bulk UFGS loader)
**Branch:** `feat/text-encoding`

---

## Problem

UFGS `.SEC` files use `windows-1252` encoding. The current ingest pipeline hardcodes `TextDecoder('utf-8', { fatal: true })` in `src/parser/sec/safety.ts`, which rejects any file with non-UTF-8 bytes. This makes the entire 666-file UFGS corpus unloadable via REST (`POST /parse`) and MCP (`parse_document`).

The fix must not be SEC-specific. Spec writers don't know what UTF-8 or windows-1252 means — they upload files. The system should handle any text encoding silently and correctly.

## Design Principle

> "Pass the butter" — one function, one job: Buffer → UTF-8 string, encoding-agnostic.

Encoding is an **ingest-only concern**. Once a file has been decoded, parsed, and stored as plain text in the `paragraphs` table, encoding is never relevant again. All read-path MCP tools (`search_library`, `get_spec`, `get_paragraph`, `generate_docx`) query the DB and return UTF-8 text — they are unaffected by this change.

---

## Scope

**In scope:**
- `src/lib/decode-text.ts` — new universal decode utility
- `src/parser/sec/safety.ts` — use `decodeTextBuffer`; change return type `void` → `string`
- `src/api/parse.ts` — use returned string from `assertSecSafe` instead of `buffer.toString('utf-8')`
- `src/mcp/tools.ts` — same for `decodeSafeBuffer`
- Tests for all changed files
- `README.md` / `ARCHITECTURE.md` doc updates

**Out of scope:**
- TXT heuristic parser (future)
- Bulk UFGS loader (issue #58 — unblocked by this, separate PR)
- DOCX encoding (DOCX is binary ZIP — not a text encoding problem)
- MCP read tools (`search_library`, `get_spec`, `get_paragraph`, `generate_docx`) — unaffected

---

## New Dependencies

| Package | Purpose | License | Weekly downloads |
|---------|---------|---------|-----------------|
| `chardet` | Byte-frequency encoding detection | MIT | ~8M |
| `iconv-lite` | Encode/decode between text encodings | MIT | ~200M |

Both have TypeScript types bundled. No native code. Zero transitive deps of concern.

---

## Architecture

### `src/lib/decode-text.ts` (new)

```typescript
import chardet from 'chardet';
import iconv from 'iconv-lite';

export function decodeTextBuffer(buf: Buffer): string {
  const encoding = chardet.detect(buf) ?? 'utf-8';
  return iconv.decode(buf, encoding);
}
```

Single exported function. Never throws. `chardet.detect` returns `null` on detection failure — fallback to `'utf-8'` handles that. `iconv-lite.decode` handles any encoding chardet returns.

**Supported encodings include:** UTF-8, windows-1252, ISO-8859-1 (latin-1), UTF-16 LE/BE, Shift-JIS, GB2312, and ~100 others.

### `src/parser/sec/safety.ts` (modified)

```typescript
import { decodeTextBuffer } from '../../lib/decode-text.js';

export function assertSecSafe(buf: Buffer): string {
  const text = decodeTextBuffer(buf);
  if (text.includes('\0')) throw new ParserError('null byte in .sec file');
  if (CONTROL_CHAR_RE.test(text)) throw new ParserError('control character in .sec file');
  if (text.split('\n').some((line) => line.replace(/\r$/, '').length > MAX_LINE_LENGTH))
    throw new ParserError('line too long in .sec file');
  return text;
}
```

Signature change: `void` → `string`. Safety checks are unchanged — they run on the decoded string. Callers that just guard (catch errors, ignore return) still work unchanged. Callers that need the string use the return value.

### Data Flow: Ingest (the only place encoding matters)

```text
Raw bytes (upload or base64-decoded)
  │
  ▼
assertSecSafe(buf): string
  ├── decodeTextBuffer(buf)       ← chardet detect + iconv-lite transcode
  └── safety checks on string     ← null bytes, control chars, line length
  │
  ▼
decoded UTF-8 string
  │
  ▼
parseSec(decodedString)           ← fast-xml-parser on UTF-8 text
  │
  ▼
CsiTree (UTF-8 text in all nodes)
  │
  ▼
INSERT INTO paragraphs (text, ...)  ← plain UTF-8 in DB forever
```

### Caller Changes

**`src/api/parse.ts`:**
```typescript
// Before:
assertSecSafe(req.file!.buffer);  // validateUpload — still fine, ignores return
// ...
tree = parseSec(buffer.toString('utf-8')).tree;  // processParseJob

// After:
assertSecSafe(req.file!.buffer);  // validateUpload — unchanged
// ...
tree = parseSec(assertSecSafe(buffer)).tree;  // processParseJob — uses returned string
```

Wait — `assertSecSafe` is called twice (once in `validateUpload`, once in `processParseJob`). Both calls are fast (< 1ms for typical SEC files). The double-call is acceptable; the alternative of threading the decoded string through the job queue adds complexity for no real benefit.

**`src/mcp/tools.ts:decodeSafeBuffer`:**
```typescript
// Before:
assertSecSafe(buf);
// ...
ext === '.sec' ? parseSec(buf.toString('utf-8')).tree : ...

// After:
const decoded = assertSecSafe(buf);
// ...
ext === '.sec' ? parseSec(decoded).tree : ...
```

Here `assertSecSafe` is called once and the returned string is used directly.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `chardet` returns `null` | Fallback to `'utf-8'` — `iconv-lite` decodes as UTF-8 |
| File is valid UTF-8 | chardet detects UTF-8, iconv-lite returns string unchanged |
| File is windows-1252 | chardet detects CP1252/ISO-8859-1 variant, iconv-lite transcodes |
| Decoded string has null byte | `ParserError('null byte in .sec file')` — unchanged |
| Decoded string has control chars | `ParserError('control character in .sec file')` — unchanged |
| Line too long | `ParserError('line too long in .sec file')` — unchanged |
| Non-text binary (e.g., ZIP uploaded as .sec) | chardet detects binary encoding or garbage — safety checks catch malformed content |

---

## Testing

### `src/lib/decode-text.test.ts` (new — unit, no DB)

- UTF-8 buffer (`Buffer.from('hello', 'utf-8')`) → returns `'hello'`
- windows-1252 buffer with em-dash byte (0x96) → returns string with `–` (U+2013)
- `chardet` null fallback: minimal 1-byte buffer that confuses chardet → returns something without throwing
- latin-1 buffer with accented char → returns correctly transcoded string

### `src/parser/sec/safety.test.ts` (modified — unit)

- Existing tests pass unchanged
- New: windows-1252 buffer (contains 0x96) → `assertSecSafe` returns decoded string, does not throw
- New: UTF-8 buffer → returns string, does not throw
- Null byte in decoded string → still throws `ParserError`

### `src/parser/sec/index.integration.test.ts` (new fixture test)

- `tests/fixtures/sec/27_10_00.SEC` (windows-1252, the fixture that previously failed) → `parseSec(assertSecSafe(buf))` succeeds, tree has `section: '27 10 00'`, `nodeCount > 0`

### Regression

All existing SEC parser tests continue to pass — `assertSecSafe` with UTF-8 input is identical in behavior (chardet detects UTF-8, iconv-lite returns unchanged string).

---

## Doc Updates

- `README.md`: update "What Works Today" → parsing section notes encoding-transparent ingest
- `ARCHITECTURE.md`: note `lib/decode-text.ts` in file structure; note chardet+iconv-lite in key dependencies
- `CLAUDE.md`: add `lib/` module boundary note — `decode-text.ts` is format-agnostic, usable by any parser

---

## Acceptance Criteria

- [ ] `27_10_00.SEC` (windows-1252 fixture) parses successfully via REST `POST /parse`
- [ ] `27_10_00.SEC` parses successfully via MCP `parse_document`
- [ ] All existing SEC parser tests pass
- [ ] `pnpm lint` clean
- [ ] `pnpm test` passes (unit)
- [ ] `pnpm test:integration` passes
