# Design: Section-Number Expansion — Suffixed Shapes Across All Formats

**Date:** 2026-06-05
**Status:** Approved (user-confirmed)
**Branch:** `feat/section-number-expansion` (worktree off origin/main @ `ba99b64`)

## Problem

SpecR canonically handles CSI section numbers as `NN NN NN` (e.g. `26 00 13`). Real-world
specifications — regardless of ingest format (.SEC, DOCX, plaintext) — use two longer shapes
that SpecR must respect as **distinct section identities**:

- **Level 4 (dotted suffix):** `26 00 13.10`, `26 00 13.20` — distinct sections, not variants
- **Level 5 (agency suffix):** `01 32 01.00 10` — trailing pair identifies the agency
  (10 = Army Corps, 20 = NAVFAC, 30/40 = NASA/AFCEC)

The UFGS reference library is the on-disk proof of scale, but suffixed numbers arrive through
every ingest path: DOCX section headers, prose cross-references in any format, and `.txt`
uploads. Corpus ground truth (`docs/references/UFGS`, 665 `.SEC` files, windows-1252):

| Shape | Count |
|---|---|
| `SECTION NN NN NN` | 422 |
| `SECTION NN NN NN.NN` | 162 |
| `SECTION NN NN NN.NN NN` | 76 |
| Whitespace dirt (leading/double spaces) | 3 |
| Bare SCN without `SECTION ` prefix | 2 |

36% of the reference corpus carries a suffix. This is core data, not an edge case.

## Audit Findings (25-agent sweep, 61 touchpoints, 18 adversarially verified)

### Broken today (suffix rejected or silently truncated)

| Site | Failure with `26 00 13.10` |
|---|---|
| `src/ast/schemas.ts` `SpecTreeSchema.section`, `PatchSpecBodySchema.section` | `/^\d{2} \d{2} \d{2}$/` → PATCH /specs/:id returns 422 |
| `src/parser/refs/rules.ts` (`csi-section-keyword` pattern) + `src/parser/refs/extract.ts` `buildRef` | Regex `\b` stops at the dot; captures base only → **cross-ref silently links to the wrong section** |
| `src/lib/infer-section.ts` `KEYWORD_RE` | Truncates `01 33 23.33` → `01 33 23` — collides two real, distinct UFGS sections (silent data corruption on upsert) |
| `src/lib/infer-section.ts` `BARE_NUM_RE` | `$`-anchored → suffixed bare header never matches → inference returns `unknown` |
| `src/lib/infer-section.ts` `INLINE_TITLE_RE` | `\b\s+` fails at the dot → inline title extraction lost entirely |
| `src/parser/text/index.ts` `SECTION_EXTRACT_RE` / `BARE_SECTION_RE` | `.txt` header truncates section and garbles title |
| `src/api/parse.ts` `workerOutputSchema.tree.section` | No regex at all → POST /parse accepts what PATCH rejects (ingestion routes disagree) |
| `src/api/generate.ts` `safeFilename` | Dot mangled to dash (cosmetic) |

### Already suffix-safe (must not regress; pin with tests)

- SEC `<SCN>`/`<SRF>` extraction (`[^<]+` captures verbatim; tests pin `27 05 13.43`)
- DB columns: all `varchar(20)` — longest real form `01 32 01.00 10` is 14 chars
- Division derivation `slice(0, 2)`; division filter `LIKE 'NN %'`
- Generator (markdown + DOCX) and MCP resources: opaque string interpolation
- Lexicographic `ORDER BY` on section strings — provably correct for this fixed-width grammar
- Exact-equality joins/lookups (`specs.section = spec_sections.section_number`, ref resolution,
  broken-ref repair) — suffix-to-suffix matches work; exact-match semantics chosen (below)

## Locked Decisions

1. **Format scope: full expanded shape.** `NN NN NN`, `NN NN NN.NN`, `NN NN NN.NN NN` are all
   first-class canonical section numbers, accepted from every ingest format (.SEC, DOCX, .txt).
2. **Linking: exact match only.** A ref to `26 00 13` never resolves to `26 00 13.10` (or vice
   versa). A base ref with no exact target stays an honest broken ref. No family fallback.
3. **Catalog: seed from UFGS.** `spec_sections` gains suffixed entries via the (fixed) seed path.
4. **Approach: single source of truth** (Approach A). One pure module owns the grammar; all
   consumers import it. Structured `SectionNumber` type with decomposed columns (Approach C)
   rejected — exact-match semantics leaves its power unused. Recorded as ADR-020.

## Architecture

### New module: `src/lib/section-number.ts` (pure, no I/O)

```typescript
/** Anchored canonical validator: single spaces, exact shape. */
export const SECTION_NUMBER_RE = /^\d{2} \d{2} \d{2}(?:\.\d{2}(?: \d{2})?)?$/;

/**
 * Composable regex fragment for scanners. Tolerates NBSP and multi-space runs
 * between groups; wraps the entire section number in ONE capture group so a
 * consumer embeds it as `new RegExp(`\\bSECTION\\s+${sectionNumberFragment()}`, 'i')`
 * and recovers the value via normalizeSectionNumber(match[1]).
 */
export function sectionNumberFragment(): string;

/** NBSP→space, collapse whitespace runs, trim. Returns canonical form, or null if
 *  the result does not match SECTION_NUMBER_RE. */
export function normalizeSectionNumber(raw: string): string | null;

/** Scan free text for section-number citations. Returns normalized values + offsets. */
export function findSectionNumbers(text: string): readonly SectionMatch[];

/** Zod schema for API/AST validation: z.string() refined by SECTION_NUMBER_RE. */
export const SectionNumberSchema: z.ZodString;
```

**Known ambiguity (documented, not solved):** in free prose, a trailing two-digit pair after a
dotted suffix is captured as an agency suffix only when it is not followed by another digit.
`Section 26 00 13.10 20 mm pipe` therefore mis-captures `26 00 13.10 20`. Rare; accepted; pinned
by a test marked `// KNOWN AMBIGUITY` per repo convention. The `.SEC` `<SRF>` path is immune
(tagged, verbatim).

### Consumer adoption (8 sites)

| Site | Change |
|---|---|
| `src/ast/schemas.ts` | Both section regexes → `SectionNumberSchema` |
| `src/api/parse.ts` (workerOutputSchema) | `section: z.string()` → `SectionNumberSchema.or(z.literal('unknown'))` — closes the parse-vs-PATCH inconsistency while allowing section-less docs |
| `src/parser/refs/rules.ts` + `extract.ts` | Pattern embeds `sectionNumberFragment()`; `buildRef` normalizes the single capture. Fixes silent truncation |
| `src/lib/infer-section.ts` | `KEYWORD_RE`, `BARE_NUM_RE`, `INLINE_TITLE_RE` rebuilt on the fragment. Fixes truncation, no-match, and lost inline titles |
| `src/parser/text/index.ts` + `signals.ts` | `SECTION_EXTRACT_RE` / `BARE_SECTION_RE` rebuilt on the fragment; suffixed `.txt` headers keep suffix and title |
| `src/parser/sec/index.ts` | SCN: tolerate optional `SECTION ` prefix (captures the 2 bare-SCN corpus files), then `normalizeSectionNumber`. SRF: normalize-or-verbatim — never reject a tagged ref; an unnormalizable SRF stays trimmed-verbatim (exact-match resolution simply won't find it) |
| `src/db/seed.ts` | Same prefix tolerance + normalize before upsert |
| `src/api/generate.ts` | `safeFilename` allows `.` → `26-00-13.10.docx`; no leading/trailing dots |

### DB migration `013_section_number_normalize_and_check.ts` (one file, two steps)

1. **Normalize existing rows** — SQL `regexp_replace` (NBSP→space, collapse runs, trim) on
   `specs.section` and `spec_sections.section_number`. If normalization would violate a unique
   constraint (two rows differing only in whitespace), the migration **aborts loudly** — no
   silent merging.
2. **CHECK constraints:**
   - `specs.section`: `value ~ '^\d{2} \d{2} \d{2}(\.\d{2}( \d{2})?)?$' OR value = 'unknown'`
     (`'unknown'` is the inference-failure sentinel persisted by the parse path)
   - `spec_sections.section_number`: pure shape check, no `'unknown'` escape (the catalog is
     seeded only from successfully extracted SCN values)
   **Deliberately no constraint** on `spec_references.target_spec_section`: that column records
   what the source document said (descriptive, not canonical); rejecting a malformed citation at
   insert would lose the ref. Exact-match resolution already leaves it unresolved.

Down migration: drops the CHECK constraints. The whitespace normalization is acknowledged
lossy/irreversible (down is a no-op for data).

No column-width changes (`varchar(20)` fits the 14-char agency form). After the parser fixes,
re-running `pnpm seed` populates suffixed catalog entries — fulfilling decision 3.

## Testing

- **Module unit suite:** normalization table — NBSP, corpus dirt (leading/double spaces), agency
  form, rejections (`26 00 13.1`, `26 00 13.10 5`, `2600 13`, `26 00 13.10.20`).
- **Regression tests named by symptom:**
  - `'refs: Section 26 00 13.10 citation — suffix retained, not truncated to base'`
  - `'infer-section: keyword scan keeps .33 — 01 33 23.33 is not 01 33 23'`
  - `'infer-section: bare suffixed header 26 00 13.10 inferred, not none'`
  - `'text parser: SECTION 27 05 13.43 - TITLE — suffix kept, title extracted'`
  - `'sec parser: bare SCN without SECTION prefix yields section'`
  - `'generate: filename preserves dotted suffix'`
- **Suffix-safety pins** for already-working paths: SRF verbatim, division slice/LIKE, markdown
  H1, DOCX title paragraph, MCP section table.
- **Integration:** agency-suffixed `.SEC` end-to-end (parse → persist → catalog join inDatabase →
  exact-match ref resolution → broken-ref repair); PATCH accepts suffixed section over HTTP;
  migration up/down round-trip.
- **KNOWN AMBIGUITY pin:** prose agency-pair capture vs trailing measurements.

## Delivery — 4 sub-MVP PRs off this branch (500-LOC gate each)

1. `feat(lib): section-number module — expanded-shape validator + normalizer` (+ ADR-020)
2. `feat(parser): adopt section-number module in refs/inference/text parsers`
3. `feat(api): accept suffixed sections in schemas, parse worker, PATCH, filenames`
   (also refreshes the four stale `NN NN NN`-only examples in ARCHITECTURE.md)
4. `feat(db): normalization + shape CHECK constraints migration, seed prefix tolerance`

Each PR independently green in CI; PRs 2–4 depend on 1.

## Out of Scope (explicit)

- Family/fuzzy cross-reference matching (exact match only; rejected by decision 2)
- Structured `SectionNumber` type / decomposed DB columns (rejected; see ADR-020)
- Sort-order changes (lexicographic order is already correct for this grammar)
- Mockup-branch SPA changes (separate branch; linkifier parity handled there later)
- MCP tool changes (division filter is unaffected by suffixes)
