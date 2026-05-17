# Section/Title Inference Design Spec

**Date:** 2026-05-16
**Status:** Approved

## Overview

DOCX files (and some other formats) frequently lack `dc:subject` / `dc:title` metadata in their core XML properties. The DOCX parser falls back to `section: 'unknown'` and `title: 'unknown'` in these cases. This spec adds a multi-pattern content inference pass that extracts section number and title from document content, validates them against the CSI MasterFormat ground truth in `csi_sections`, fuzzy-matches the titles, and surfaces inference metadata to MCP callers so LLMs can prompt users when human verification is needed.

Design philosophy: **deterministic-first, MCP-integrated day one.** Algorithmic inference produces a result; the audit trail tells the LLM how confident to be; the LLM decides whether to surface a verification prompt.

---

## Architecture

```text
src/lib/infer-section.ts            ← inferSectionMeta(tree): SectionInference (pure, no I/O)
src/lib/infer-section.test.ts       ← unit tests
src/lib/infer-section.integration.test.ts ← real DOCX fixture + DB
src/db/queries/search.ts            ← add lookupCsiSectionTitle(section): Promise<string | null>
src/db/index.ts                     ← re-export lookupCsiSectionTitle
src/parser/index.ts                 ← call inferSectionMeta in parse(); update ParseResult
src/lib/file-loader.ts              ← LoadResult gains inferenceWarnings[]; call lookup + enrich
src/mcp/tools.ts                    ← parse_document + load_files include sectionInference in response
```

---

## Inference Algorithm

`inferSectionMeta(tree: CsiTree): SectionInference`

**Input:** A `CsiTree` that may have `section: 'unknown'`.

**Step 1: Early exit.** If `tree.section !== 'unknown'`, return immediately:
```typescript
{ method: 'metadata', confidence: 'high', inferredSection: tree.section, inferredTitle: tree.title, titleMatch: 'unknown' }
```

**Step 2: Flatten first 50 nodes** via DFS — stop collecting once 50 reached.

**Step 3: Level 1 scan** (high confidence) — iterate nodes 0–49:
- Pattern: `/SECTION\s+(\d{2})\s+(\d{2})\s+(\d{2})/i` anywhere in node text
- On match: extract section number (e.g., `'26 09 33'`)
- Extract title: check if text continues after the number (e.g., `"SECTION 26 09 33 VARIABLE FREQUENCY..."`) → extract remainder as title candidate
- If no inline title: scan nodes i+1..i+10, first non-blank text with 3–150 chars that doesn't itself match a section pattern
- Return `method: 'content-high'`, `confidence: 'high'`

**Step 4: Level 2 scan** (medium confidence) — only reached if Level 1 found nothing:
- Pattern: `/^(\d{2})\s+(\d{2})\s+(\d{2})$/` on `text.trim()` — entire text must be the number, no surrounding content
- Same title extraction as Level 1
- Return `method: 'content-medium'`, `confidence: 'medium'`

**Step 5: No match** — return `method: 'none'`, `confidence: 'none'`, `inferredSection: 'unknown'`, `inferredTitle: 'unknown'`, `titleMatch: 'unknown'`

**Title extraction caps:** 3–150 chars, not all-numeric, not pure whitespace, not matching a section number pattern itself.

**Never throws.** Any internal error returns `method: 'none'`.

---

## Fuzzy Title Matching

Implemented in the calling layer (enrichment step in `file-loader.ts` and `handleParseDocument`) after `standardTitle` is retrieved via DB lookup. `inferSectionMeta` itself never computes fuzzy match — it always returns `titleMatch: 'unknown'`.

```typescript
function titleMatchScore(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 1 : intersection / union;
}
```

`titleMatch` categories:

| Value | Condition |
|-------|-----------|
| `'exact'` | Normalized strings identical |
| `'close'` | `score >= 0.7` |
| `'divergent'` | `score < 0.7` |
| `'unknown'` | No `standardTitle` to compare |

Since `standardTitle` is populated via DB lookup after `parse()` returns, the fuzzy match runs in the enrichment step (in `file-loader.ts` and `handleParseDocument`), not inside the pure `inferSectionMeta` function. `inferSectionMeta` always returns `titleMatch: 'unknown'` and omits `standardTitle` and `titleMatchScore`. Enrichment creates a new immutable `SectionInference` object via spread — no mutation.

---

## Types

### `SectionInference` (in `src/lib/infer-section.ts`)

```typescript
export interface SectionInference {
  readonly method: 'metadata' | 'content-high' | 'content-medium' | 'none';
  readonly confidence: 'high' | 'medium' | 'none';
  readonly inferredSection: string;     // may be 'unknown'
  readonly inferredTitle: string;       // may be 'unknown'
  readonly standardTitle?: string;      // from csi_sections lookup; absent if not found or lookup failed
  readonly titleMatchScore?: number;    // 0–1 Jaccard; absent when standardTitle absent
  readonly titleMatch: 'exact' | 'close' | 'divergent' | 'unknown';
}
```

### `ParseResult` update (in `src/parser/index.ts`)

```typescript
export interface ParseResult {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
  readonly sectionInference: SectionInference;  // always present
}
```

### `LoadResult` update (in `src/lib/file-loader.ts`)

```typescript
export interface InferenceWarning {
  readonly file: string;
  readonly specId: string;
  readonly inferredSection: string;
  readonly inferredTitle: string;
  readonly standardTitle: string | null;
  readonly titleMatchScore: number | null;
  readonly titleMatch: 'exact' | 'close' | 'divergent' | 'unknown';
  readonly confidence: 'high' | 'medium';
  readonly note: string;
}

export interface LoadResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly error: string }>;
  readonly inferenceWarnings: ReadonlyArray<InferenceWarning>;
}
```

---

## Pipeline Integration

```text
parse(buffer, filename)
  └── parseDocx / parseSec → CsiTree (may have section: 'unknown')
  └── inferSectionMeta(tree) → SectionInference  [pure; no DB]
  └── if confidence !== 'none':
        enrichedTree = { ...tree, section: inferredSection, title: inferredTitle }
  └── return ParseResult { tree: enrichedTree, refs, sectionInference }

loadFiles / handleParseDocument
  └── persistParsedSpec(result) → specId
  └── if sectionInference.confidence !== 'none':
        standardTitle = await lookupCsiSectionTitle(inferredSection)
        score = standardTitle ? titleMatchScore(inferredTitle, standardTitle) : undefined
        titleMatch = computeTitleMatch(score)
        enrich sectionInference with { standardTitle, titleMatchScore: score, titleMatch }
  └── include enriched sectionInference in response
```

`parse()` always returns `ParseResult` with `sectionInference` present. The `standardTitle`, `titleMatchScore`, and `titleMatch` fields are populated in the calling layer (not inside the pure `inferSectionMeta` function) after the DB lookup.

---

## New DB Query

**File:** `src/db/queries/search.ts`

```typescript
export async function lookupCsiSectionTitle(sectionNumber: string): Promise<string | null> {
  try {
    const result = await pool.query<{ title: string }>(
      `SELECT title FROM csi_sections WHERE section_number = $1 LIMIT 1`,
      [sectionNumber]
    );
    return result.rows[0]?.title ?? null;
  } catch (err) {
    throw new DatabaseError('lookupCsiSectionTitle failed', { cause: err });
  }
}
```

Re-exported from `src/db/index.ts`.

---

## MCP Tool Response Changes

### `parse_document`

When `sectionInference.method !== 'metadata'` (inference fired), include in response:

```json
{
  "specId": "...",
  "section": "26 09 33",
  "title": "VARIABLE FREQUENCY MOTOR CONTROLLERS",
  "nodeCount": 123,
  "sectionInference": {
    "method": "content-high",
    "confidence": "high",
    "inferredSection": "26 09 33",
    "inferredTitle": "VARIABLE FREQUENCY MOTOR CONTROLLERS",
    "standardTitle": "Variable Frequency Motor Controllers",
    "titleMatchScore": 0.92,
    "titleMatch": "close",
    "note": "Section metadata missing from file. Inferred from content (SECTION keyword). Standard CSI title found. Please verify."
  }
}
```

When `method === 'metadata'`: `sectionInference` omitted from response — no noise for clean files.

### `load_files`

```json
{
  "total": 10,
  "succeeded": 10,
  "failed": 0,
  "errors": [],
  "inferenceWarnings": [
    {
      "file": "docs/references/ARCAT/26_09_33.docx",
      "specId": "...",
      "inferredSection": "26 09 33",
      "inferredTitle": "VARIABLE FREQUENCY MOTOR CONTROLLERS",
      "standardTitle": "Variable Frequency Motor Controllers",
      "titleMatchScore": 0.92,
      "titleMatch": "close",
      "confidence": "high",
      "note": "Section metadata missing. Inferred from content. Please verify."
    }
  ]
}
```

`inferenceWarnings: []` when all files had clean metadata.

---

## LLM Caller Contract

| `titleMatch` | LLM action |
|-------------|------------|
| `exact` | Proceed without prompting user |
| `close` | Proceed; optionally note inference was used |
| `divergent` | Surface both `inferredTitle` and `standardTitle`; ask user to confirm which is correct |
| `unknown` | Note section not in CSI DB — may be proprietary, non-standard, or section number inference is wrong; ask user to verify |

When `confidence === 'medium'`: always prompt user regardless of `titleMatch`.

---

## Error Handling

| Site | Behavior |
|------|---------|
| `inferSectionMeta` internal error | Returns `method: 'none'` — never throws |
| `lookupCsiSectionTitle` DB error | Throws `DatabaseError` — caught in `file-loader.ts`; `standardTitle: null`, `titleMatch: 'unknown'`; warning still emitted |
| Inference fires but section not in `csi_sections` | `standardTitle: null`, `titleMatch: 'unknown'` |
| Inference fails entirely | Section/title stay `'unknown'`; no `inferenceWarning` emitted |

Inference failure never blocks parse or persist.

---

## Testing

### Unit tests (`src/lib/infer-section.test.ts`)

No DB, no I/O — mock `CsiTree` nodes directly.

| Test | Asserts |
|------|---------|
| Clean metadata (section already set) | `method: 'metadata'`, tree section unchanged |
| `'SECTION 26 09 33'` in node text | `confidence: 'high'`, `inferredSection: '26 09 33'` |
| Title inline after number | Title extracted from same node text |
| Title on next node | Title extracted from node i+1 |
| Blank nodes between section and title | Skipped; title found in i+2 |
| Bare `'26 09 33'` entire text | `confidence: 'medium'` |
| `'See paragraph 26 09 33 for details'` | NOT matched (not whole-text) |
| Garbage preamble (tables, legal boilerplate) before SECTION line | Section found within 50 nodes |
| Nothing found in 50 nodes | `confidence: 'none'`, `inferredSection: 'unknown'` |
| Empty parts array | `confidence: 'none'` |
| Fuzzy match exact | `titleMatch: 'exact'` |
| Fuzzy match close (≥0.7) | `titleMatch: 'close'` |
| Fuzzy match divergent (<0.7) | `titleMatch: 'divergent'` |
| No standardTitle | `titleMatch: 'unknown'`, `titleMatchScore` absent |

### Integration tests (`src/lib/infer-section.integration.test.ts`)

Real ARCAT DOCX fixture + real DB.

| Test | Asserts |
|------|---------|
| Parse `26_09_33.docx` via `parse()` | `sectionInference.confidence === 'high'`, `inferredSection === '26 09 33'` |
| `lookupCsiSectionTitle('26 09 33')` | Returns non-null standard title |
| `tree.section` updated before persist | DB row has `section = '26 09 33'`, not `'unknown'` |
| `load_files` on ARCAT DOCX | `inferenceWarnings` contains entry with `confidence: 'high'` |
| `load_files` on UFGS SEC | `inferenceWarnings` empty (SEC has clean metadata) |

---

## Out of Scope

- Retroactive re-inference on already-loaded specs (follow-on; requires re-parse job)
- Web UI confirmation flow (Phase 5)
- Inference for PDF/Markdown formats (no parser yet)
- Persisting `sectionInference` metadata to DB (kept in-flight only; Web UI flow will need a `spec_inference_log` table — follow-on)
