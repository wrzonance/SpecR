# Phase 1c-ii: DOCX Hierarchy Inference Engine + POST /parse

**Date:** 2026-05-10  
**Status:** Approved  
**Issue:** #12  
**Branch:** `feat/parser-docx-1c-ii`

---

## Scope

Build on Phase 1c-i (numbering.xml + styles.xml analyzers) to complete the DOCX parser pipeline:

- `document.ts` — extract `DocxParagraph[]` from `word/document.xml`
- `inference.ts` — two-pass 5-signal hierarchy inference engine
- `heuristics.ts` — signal 4 (text regex) + signal 5 (indentation) helpers
- `index.ts` — DOCX parser orchestrator
- `src/lib/jobs.ts` — in-memory async job store
- `src/api/parse.ts` — `POST /parse` + `GET /parse/jobs/:jobId` endpoints
- Wire into `src/parser/index.ts` and `src/api/router.ts`

**Out of scope:**
- Cross-reference extraction from DOCX (Phase 1c-iii — see issue #12 notes)
- DOCX generation (Phase 2)
- Security hardening of upload inputs (issue #19)
- Style template system (issue #20)

---

## Architecture

### New files

```
src/parser/docx/
  document.ts      # Extract DocxParagraph[] from word/document.xml
  inference.ts     # Pass 1 + Pass 2: classify → build CsiTree
  heuristics.ts    # Signal 4 (text regex) + Signal 5 (indentation)
  index.ts         # Orchestrator: JSZip → analyzers → inference → CsiTree

src/api/
  parse.ts         # POST /parse + GET /parse/jobs/:jobId

src/lib/
  jobs.ts          # In-memory async job store
```

### Modified files

```
src/parser/docx/types.ts   # Add ClassifiedParagraph, SignalConflict
src/parser/index.ts        # Export parseDocx alongside parseSec
src/api/router.ts          # Wire POST /parse, GET /parse/jobs/:jobId with multer
```

### Module boundaries

| Module | Allowed dependencies | Forbidden |
|--------|---------------------|-----------|
| `document.ts`, `inference.ts`, `heuristics.ts` | `types.ts`, `rules.ts`, `ast/types` | I/O, DB, HTTP |
| `index.ts` (docx) | All docx sub-modules, `ast/types`, `jszip` | DB, HTTP |
| `jobs.ts` | Node built-ins only | DB, parser, HTTP |
| `parse.ts` (api) | `parser/index`, `db/queries/*`, `lib/jobs`, `multer` | Direct parser internals |

---

## Data Types (additions to `types.ts`)

```typescript
export interface SignalConflict {
  readonly signal: 1 | 2 | 3 | 4 | 5;
  readonly reportedIlvl: number;
  readonly reportedNodeType: NodeType;
}

export interface ClassifiedParagraph {
  readonly paragraph: DocxParagraph;
  readonly resolvedIlvl: number;       // canonical CSI ilvl 0–8, normalized
  readonly nodeType: NodeType;
  readonly signalUsed: 1 | 2 | 3 | 4 | 5;
  readonly conflicts: readonly SignalConflict[];
  readonly isVanish: boolean;
}
```

---

## `document.ts` — Paragraph Extraction

`parseDocument(xml: string, numberingMap: NumberingMap): DocxParagraph[]`

Walks `w:body > w:p` with fast-xml-parser (same config as `numbering.ts`/`styles.ts`).

// SECURITY TODO (issue #19): audit fast-xml-parser options — ensure processEntities
// is configured to block XXE via DOCTYPE/ENTITY declarations.

Per-paragraph field extraction:

| Field | Source in OOXML |
|-------|----------------|
| `text` | Concat all `w:r > w:t` runs; preserve `xml:space="preserve"` whitespace runs |
| `styleId` | `w:pPr > w:pStyle @w:val` |
| `numId` | `w:pPr > w:numPr > w:numId @w:val` (integer); absent → `undefined` |
| `ilvl` | `w:pPr > w:numPr > w:ilvl @w:val` (integer); absent → `undefined` |
| `leftIndent` | `w:pPr > w:ind @w:left` (twips); absent → `undefined` |
| `outlineLvl` | `w:pPr > w:outlineLvl @w:val` (integer); absent → `undefined` |
| `isVanish` | `w:pPr > w:rPr > w:vanish` present → `true` |

`numberingMap` passed in to resolve style-inherited `numId`/`ilvl` via `pStyleToNumId`/`pStyleToIlvl` when paragraph has no own `w:numPr` but its style carries numbering. This merges signal 1+2 data at extraction, keeping `inference.ts` clean.

Empty paragraphs → `text: ''`, not an error.

---

## `heuristics.ts` — Signals 4 and 5

### Signal 4: text content regex

All patterns anchored to `^` of `text.trim()`. Minimum length guard: `text.trim().length > 3` — prevents orphaned punctuation false-positives.

```typescript
// Pattern → NodeType
/^PART\s+\d+/i        → 'part'
/^\d+\.\d+\s+/        → 'article'   // "1.1 HEADING"
/^[A-Z]\.\s/          → 'pr1'       // "A. text"  (uppercase only)
/^\d+\.\s/            → 'pr2'       // "1. text"
/^[a-z]\.\s/          → 'pr3'       // "a. text"  (lowercase only)
/^\d+\)\s/            → 'pr4'       // "1) text"
/^[a-z]\)\s/          → 'pr5'       // "a) text"  (NOT mid-word "3i)" in product codes)
```

`matchTextSignal(text: string): { nodeType: NodeType; ilvl: number } | null`

Returns `null` if no pattern matches — inference falls through to signal 5.

### Signal 5: indentation

```typescript
matchIndentSignal(leftIndent: number | undefined, articleIlvl: number): number | null
```

`Math.round(leftIndent / 576)` → ilvl estimate. Returns `null` if `leftIndent` is undefined or result is out of range 0–8. Low-confidence fallback only.

---

## `inference.ts` — Two-Pass Inference

### Pass 1: `classifyParagraphs`

```typescript
classifyParagraphs(
  paragraphs: readonly DocxParagraph[],
  numberingMap: NumberingMap,
  styleMap: StyleMap
): ClassifiedParagraph[]
```

For each paragraph, check signals 1→5 in priority order. First match wins. All other signals that fired with a different result are appended to `conflicts[]`.

| Priority | Signal | Condition |
|----------|--------|-----------|
| 1 | Numbering XML | paragraph has own `numId > 0` + `ilvl` in `w:pPr` |
| 2 | Style chain | `styleMap.resolvedNumPr` has entry for `styleId` AND `suppressesNumbering` is false |
| 3 | Document order | prev classified ilvl ± 1, no jump > 1 down (context: single lookback) |
| 4 | Text content | `heuristics.matchTextSignal` returns non-null |
| 5 | Indentation | `heuristics.matchIndentSignal` returns non-null |

`ilvl → NodeType` lookup uses `numberingMap.articleIlvl` to select `ARCAT_ILVL_MAP` (articleIlvl=1) or `CPI_ILVL_MAP` (articleIlvl=3) from `rules.ts`.

**Continuation paragraphs:** no signal fires → `nodeType: 'continuation'`, `resolvedIlvl` inherited from previous paragraph, `signalUsed: 3`.

**Vanish paragraphs:** processed normally through signals, but `isVanish: true` is carried; `nodeType` overridden to `'note'` in pass 2 tree output.

### Pass 2: `buildTree`

```typescript
buildTree(
  classified: readonly ClassifiedParagraph[],
  section: string,
  title: string
): CsiTree
```

Stack-based parent assignment:

```
stack: ClassifiedParagraph[]
// invariant: stack[i].resolvedIlvl < stack[i+1].resolvedIlvl

for each paragraph p:
  if p.nodeType === 'continuation':
    parent = last classified non-continuation paragraph
  else:
    pop stack until top.resolvedIlvl < p.resolvedIlvl
    parent = stack.top (null → root Part node)
    push p onto stack
```

Edge cases:

| Case | Behavior |
|------|----------|
| ilvl jump forward > 1 (e.g. 0→3) | pop to last < 3; assign to that parent — no synthetic nodes |
| ilvl jump back (e.g. 4→1) | pop until top.ilvl < 1; assign to that parent |
| isVanish | included as `'note'` child, same stack logic |
| continuation | child of textual predecessor regardless of ilvl |

UUIDs assigned here: one `uuid()` per node. `meta.source` set from `numberingMap.articleIlvl`:
- `articleIlvl === 1` → `'arcat'`
- `articleIlvl === 3` → `'cpi'`  
- else → `'unknown'`

`meta.signalUsed` and `meta.conflicts` carried from pass 1 into `CsiNode.meta` for MCP surfacing.

---

## `index.ts` — Orchestrator

```typescript
parseDocx(buffer: Buffer, onProgress?: (stage: string, pct: number) => void): Promise<CsiTree>
```

// SECURITY TODO (issue #19): add uncompressed size check after JSZip.loadAsync —
// reject if total uncompressed bytes > 50MB to prevent ZIP bomb exhaustion.

Pipeline:

```
JSZip.loadAsync(buffer)
  ↓ onProgress('extracting', 10)
  ↓ extract word/numbering.xml  (optional — absent in inline-only docs)
  ↓ extract word/styles.xml     (required — throw ParserError if missing)
  ↓ extract word/document.xml   (required — throw ParserError if missing)
  ↓ extract docProps/core.xml   (optional — for section/title metadata)
  ↓ onProgress('numbering', 25)
parseNumberingXml(numberingXml ?? '')
  ↓ onProgress('styles', 40)
parseStylesXml(stylesXml)
  ↓ onProgress('document', 55)
parseDocument(documentXml, numberingMap)
  ↓ onProgress('classifying', 75)
classifyParagraphs(paragraphs, numberingMap, styleMap)
buildTree(classified, section, title)
  ↓ onProgress('complete', 100)
→ CsiTree
```

`section` and `title` extracted from `docProps/core.xml` `<dc:subject>` / `<dc:title>` if present, else `'unknown'`. Caller (`parse.ts`) overrides via request body fields.

---

## `src/lib/jobs.ts` — Async Job Store

```typescript
type ParseStage =
  | 'queued' | 'extracting' | 'numbering' | 'styles'
  | 'document' | 'classifying' | 'persisting' | 'complete' | 'failed'

interface ParseJob {
  readonly jobId: string;
  status: ParseStage;
  progress: { stage: ParseStage; pct: number };
  result?: { specId: string; section: string; title: string; nodeCount: number };
  error?: string;
  expiresAt: number;  // Date.now() + 3_600_000 (1 hour)
}
```

In-memory `Map<string, ParseJob>`. Entries auto-expire via `setTimeout`. No DB persistence across restarts — acceptable for Phase 1c-ii. Phase 2+ can replace with a proper queue.

Exports: `createJob()`, `updateJob()`, `getJob()`.

---

## `src/api/parse.ts` — Endpoints

### `POST /parse`

```
Content-Type: multipart/form-data
  file: <.docx or .sec>   (required)
  section?: string         (override extracted section number)
  title?: string           (override extracted title)

→ 202 Accepted
{ jobId: string }
```

// SECURITY TODO (issue #19): validate MIME type — .docx must be
// application/vnd.openxmlformats-officedocument.wordprocessingml.document
// AND magic bytes PK\x03\x04. Reject mismatch.

multer: `fileSize` limit 10MB. Single file field `'file'`.

Flow:
1. Create job via `jobs.createJob()` → `{ jobId }`
2. Return 202 immediately
3. Kick off `processParseJob(jobId, file, body)` — unawaited async

`processParseJob`:
1. Detect format from `file.originalname` extension
2. `.sec` → `parseSec(buffer)` (existing); `.docx` → `parseDocx(buffer, onProgress)`
3. Override `section`/`title` from body if provided
4. `onProgress` callback → `jobs.updateJob(jobId, { stage, pct })`
5. `pct: 90` → DB transaction: INSERT specs + recursive paragraph INSERT batch
6. `pct: 100` → `jobs.updateJob(jobId, { status: 'complete', result })`

Unknown extension → job `status: 'failed'`, `error: 'unsupported format'`.  
Any thrown error → job `status: 'failed'`, `error: err.message`.  
No partial DB writes — all inserts in a single transaction.

### `GET /parse/jobs/:jobId`

```
→ 200: { jobId, status, progress, result?, error? }
→ 404: { error: 'job not found' }
```

Note for Phase 5 (Web UI): progress bar polls this endpoint. When SSE is added, same stage events stream instead. `GET /parse/jobs/:jobId` remains as polling fallback.

---

## Error Handling

| Condition | Error | HTTP |
|-----------|-------|------|
| Unknown extension | `ParserError('unsupported format: .xyz')` | job failed |
| Missing `word/document.xml` or `word/styles.xml` | `ParserError('...', { cause })` | job failed |
| Corrupt ZIP | `ParserError('failed to read DOCX archive', { cause })` | job failed |
| XML parse failure | `ParserError('failed to parse <file>', { cause })` | job failed |
| Zero paragraphs | `ParserError('document contains no paragraphs')` | job failed |
| DB insert failure | stored as job error | job failed |
| Job not found | — | 404 |

All errors inside `processParseJob` are caught and stored in job map — never crash the process.

---

## Testing

### Unit tests (no I/O, no DB)

| File | Coverage |
|------|----------|
| `document.test.ts` | Text concat, entity decode (`&lt;` → `<`), empty paragraphs, vanish detection, style-inherited numPr resolution |
| `heuristics.test.ts` | Regex anchoring: "3i)" does NOT match pr5; "a) text" DOES; editorial `<Insert>` passes through; min-length guard |
| `inference.test.ts` | Pass 1: each signal in isolation; pass 2: stack algorithm — ilvl jumps, gaps, continuations, vanish nodes |

### Integration tests (real fixtures, no DB)

| File | Coverage |
|------|----------|
| `arcat.integration.test.ts` | Each ARCAT `.docx` fixture → assert 3 parts, correct article count, no `'unknown'` nodeTypes, `source: 'arcat'` |
| `cpi.integration.test.ts` | Each CPI `.docx` fixture → `source: 'cpi'`, continuation paragraphs correctly typed, `PR1lc` → `'continuation'` not `'pr1'` |

Regression test names follow CLAUDE.md convention: `'inference: CPI numId=0 continuation — PR1lc not classified as pr1'`.

Known ambiguous cases marked `// KNOWN AMBIGUITY: <description>`.

### Integration tests (with DB — `pnpm test:integration`)

| File | Coverage |
|------|----------|
| `parse.integration.test.ts` | `POST /parse` with ARCAT fixture → 202 → poll `GET /parse/jobs/:jobId` until complete → verify spec + paragraph rows in DB |

---

## Manual Testing (no UI)

Three layers, in order of speed:

### 1. `scripts/parse-debug.ts` — fastest, no server, no DB

```bash
pnpm tsx scripts/parse-debug.ts docs/references/ARCAT/01_10_00arc.docx
```

Calls `parseDocx(buffer)` directly, prints human-readable tree to stdout:

```
Parsed: 01 10 00 — Summary of Work
Source:  arcat
Nodes:   127

PART 1 - GENERAL                      [part,    sig:4]
  1.1 SUMMARY                         [article, sig:1]
    A. Section includes...            [pr1,     sig:1]
       See Section 09 91 00           [continuation, sig:3]

Conflicts (2):
  #34  sig1=pr2 sig4=pr1  "A. Provide..."
  #89  sig2=article sig4=pr2  "1.1..."
```

Dev loop: edit inference → run script → inspect → repeat. No process startup.

### 2. curl + jq — full pipeline with DB

```bash
# Upload
JOB=$(curl -s -F file=@fixture.docx http://localhost:3000/parse | jq -r '.jobId')
# Poll
watch -n1 "curl -s http://localhost:3000/parse/jobs/$JOB | jq '.progress'"
# Inspect tree
SPEC=$(curl -s http://localhost:3000/parse/jobs/$JOB | jq -r '.result.specId')
curl -s http://localhost:3000/specs/$SPEC | jq '.'
```

`GET /specs/:id` returns full `CsiTree` JSON — existing endpoint, no new code.

### 3. Vitest snapshot tests — regression guard

```bash
pnpm test src/parser/docx/arcat.integration.test.ts
```

First run generates JSON snapshots; subsequent runs catch regressions automatically. Covers all ARCAT + CPI fixtures.

---

## Related Issues

- #12 — Phase 1c tracking issue (this sub-MVP closes it)
- #19 — Security: sanitize DOCX upload inputs (follow-up)
- #20 — Phase 2b: firm style template engine (follow-up)
