# Plaintext Spec Parser — Design

**Date:** 2026-05-16  
**Issue:** [#64](https://github.com/wrzonance/SpecR/issues/64)  
**Status:** Approved — pending implementation

---

## Summary

Add a standalone plaintext (`.txt`) parser pipeline to SpecR. Extends the text-content signal (signal 5 from the DOCX inference engine) into a self-contained parser for files with no structural metadata. Read-only ingest — no round-trip anchors possible without merge UUIDs.

---

## Architecture

### New module: `src/parser/text/`

Two files:

**`src/parser/text/signals.ts`**

Pure function `classifyLine(line: string): LineClassification`:

```typescript
interface LineClassification {
  readonly type: NodeType | 'continuation' | 'blank' | 'header';
  readonly text: string;   // line with matched prefix removed
  readonly level: number;  // 0=part, 1=article, 2=pr1, ... 6=pr5
}
```

**`src/parser/text/index.ts`**

`parseText(text: string): { tree: CsiTree; refs: readonly SecRef[]; capabilities: readonly string[] }`

- Splits input into lines
- Extracts section/title from first 10 non-blank lines (pattern: `SECTION XX XX XX - TITLE`)
- Walks lines through `classifyLine` signal cascade
- Builds tree with stack algorithm
- Returns `refs: []` (no cross-reference extraction for plaintext)

### Wiring — 3 touch points

| File | Change |
|------|--------|
| `src/parser/index.ts` | Add `.txt` case: `decodeTextBuffer(buffer)` → `parseText(text)` |
| `src/api/parse.ts` | Add `'.txt'` to `ALLOWED_EXT`; no MIME check (text-only, same as `.sec`); add `.txt` branch in `processParseJob` |
| `src/mcp/tools.ts` | Update `load_files` inputSchema description to mention `.txt` |

`src/lib/file-loader.ts` gets `.txt` support for free — it calls `parse(buffer, filename)` which dispatches by extension.

### ParseResult extension

```typescript
export interface ParseResult {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
  readonly sectionInference: SectionInference;
  readonly capabilities?: readonly string[];  // ['read-only'] for text parser
}
```

Parse job result (`GET /parse/jobs/:jobId`) response includes optional `capabilities` field:

```json
{ "specId": "...", "section": "...", "title": "...", "nodeCount": 42, "capabilities": ["read-only"] }
```

---

## Signal Cascade

`classifyLine` tests patterns in priority order. Strip leading whitespace before matching — indentation is a separate signal, not part of prefix detection.

| Priority | Pattern | NodeType | level |
|----------|---------|----------|-------|
| 1 | `^SECTION \d{2} \d{2} \d{2}` | `header` (metadata only) | — |
| 2 | `^PART \d+ [-—]` or `^PART \d+\s*$` | `part` | 0 |
| 3 | `^\d+\.\d+[ ]` | `article` | 1 |
| 4 | `^[A-Z]\.\s+` | `pr1` | 2 |
| 5 | `^\d+\.\s+` | `pr2` | 3 |
| 6 | `^[a-z]\.\s+` | `pr3` | 4 |
| 7 | `^\d+\)\s+` | `pr4` | 5 |
| 8 | `^[a-z]\)\s+` | `pr5` | 6 |
| 9 | Indentation ÷ 4sp (or 1 tab = 4sp) | level estimate | computed |
| 10 | Non-blank, no match | `continuation` | same as parent |
| — | Blank line | separator | — |

**`pr2` guard:** `^\d+\.\s+\S` — only classify as `pr2` when followed by whitespace then non-empty text, to avoid false positives on sentences ending in period at line boundary.

**Known ambiguities (documented in tests):**
- Single-word ALL-CAPS lines that aren't PART (e.g., `NOTE:`) — treated as `continuation`
- `1.` at line end with no following text — treated as `continuation`

---

## Tree Building Algorithm

Stack-based, same approach as DOCX inference engine:

```text
stack: CsiNode[]  ← open ancestor stack
root: CsiNode[]   ← top-level part nodes

for each classified line:
  if blank:
    pop stack until level < article (1) — don't lose part context
  elif type == 'header':
    skip (used for section/title extraction only)
  elif type == 'continuation':
    if stack not empty (stack.length > 1):
      attach as child of stack.top; do not push
    else:
      skip (no structural parent yet — continuation before first PART is dropped)
  else:
    while stack.top.level >= this.level: stack.pop()
    node = new CsiNode(type, text, uuid)
    attach to stack.top.children (or root if stack empty)
    stack.push(node)
```

Level mapping: `part=0, article=1, pr1=2, pr2=3, pr3=4, pr4=5, pr5=6`

Section/title: if `SECTION XX XX XX - TITLE` found in first 10 non-blank lines, use that. Otherwise `inferSectionMeta(tree)` runs as usual (same as DOCX/SEC paths).

---

## Fixtures

Three fixture files in `tests/fixtures/text/`:

| File | Description | Primary signals tested |
|------|-------------|----------------------|
| `ufgs-27-10-00.txt` | Telecom section derived from UFGS 27 10 00 .SEC | PART/article/PR prefix cascade, blank-line grouping |
| `numbered-prefixes.txt` | Synthetic: SECTION 03 30 00, PART/1.1/A./1./a./1)/a) hierarchy | Full 4-signal cascade including all prefix types |
| `indent-only.txt` | Synthetic: no numbering prefixes, 4-space indent | Indentation-only hierarchy fallback |

Generation strategy: parse UFGS `.SEC` → `renderMarkdown()` output → strip Markdown syntax → save as `.txt`. Validates that text parser can parse SpecR's own output.

---

## API Surface

### `POST /parse`

- Accepts `.txt` file upload (multipart `file` field)
- No MIME check (same pattern as `.sec` — only `.docx` validates MIME in `validateUpload`)
- No safety check needed (not an archive format, not XML — text content only)
- Progress: `extracting (10%) → classifying (75%) → persisting (90%) → complete (100%)`
- Job result includes `"capabilities": ["read-only"]`

### `load_files` MCP tool + `pnpm load:files` CLI

- Updated description: "Accepts `.SEC`, `.docx`, and `.txt` formats"
- Glob patterns like `**/*.txt` now work
- No logic change — extension dispatch handles it

---

## Testing Strategy

**Unit tests** (`tests/unit/parser/text/`):

- `classifyLine`: one test per signal type + known ambiguity cases
- `parseText`: full round-trip against each fixture file
  - Verify PART/article count matches expected
  - Verify section + title extraction
  - Verify `capabilities: ['read-only']` in ParseResult
- Stack algorithm edge cases: ilvl gap (PART → PR1 with no article), blank-line grouping, continuation under pr2

**Integration test** (`tests/integration/`):

- Upload `.txt` fixture via `POST /parse`, poll to complete, verify `nodeCount > 0` and `capabilities: ['read-only']`
- `loadFiles(['tests/fixtures/text/ufgs-27-10-00.txt'])` — verify spec inserted, inference warning surfaced

All ambiguity cases marked `// KNOWN AMBIGUITY: <description>` in test file.

---

## README Changes (in PR)

- Status table: add row `| 1c-iii | Plaintext \`.txt\` parser — 4-signal hierarchy inference | ✅ Complete (PR #XX) |`
- "What Works Today / Parsing" section: add plaintext parser entry
- "Not Yet Built": no plaintext entry (it will be built)
- PR description: `Closes #64`

---

## Out of Scope

- Round-trip / merge anchors (plaintext has none — read-only by definition)
- PDF parsing (issue #65, Phase 3, depends on this)
- OCR or binary format handling
- Phase 2c style template engine (separate sub-MVP)
