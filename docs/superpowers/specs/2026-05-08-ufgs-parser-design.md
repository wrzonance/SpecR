# Sub-MVP 1a: UFGS Parser + Cross-Reference Model

**Date:** 2026-05-08
**Phase:** 1a (prerequisite for 1b and 1c)
**GitHub issues:** #11 (1b), #12 (1c), #13 (ADR-011)

---

## Scope

This PR delivers:
1. DB migrations: `projects`, `project_specs`, `spec_references` (schema only, no API)
2. UFGS .SEC parser: SpecsIntact XML → canonical `CsiTree` → PostgreSQL
3. Cross-reference extraction at parse time → `spec_references` table
4. Bulk corpus loader: all 666 UFGS .SEC files → library namespace

**Out of scope:**
- Project/TOC API (sub-MVP 1b, issue #11)
- TOC-level cascade logic (sub-MVP 1b)
- DOCX parsing (sub-MVP 1c, issue #12)
- `POST /parse` HTTP endpoint (sub-MVP 1c)
- `parse_jobs` async table (sub-MVP 1c — see note below)

**Note on async DOCX parsing:** DOCX files via `POST /parse` will require an async job pattern (`parse_jobs` table + status polling) due to large file sizes and 5-signal inference cost. The `.SEC` bulk loader is a CLI script, not an HTTP endpoint, so synchronous Option B (parse → in-memory AST → persist) is correct here. The `CsiTree` return type is designed to be identical to what the DOCX async worker will produce in 1c.

---

## Architecture

### Module structure

```
src/
├── parser/
│   ├── index.ts          # parse(filePath, format) → CsiTree  (public API)
│   ├── error.ts          # ParserError extends SpecrError
│   └── sec/
│       ├── index.ts      # parseSec(xml: string) → CsiTree
│       ├── elements.ts   # typed wrappers for SEC XML element shapes (Zod)
│       └── refs.ts       # extractRefs(tree, xml) → SecReference[]
├── db/
│   ├── migrations/
│   │   ├── 005_specs_unique_constraint.ts
│   │   ├── 006_create_projects.ts
│   │   ├── 007_create_project_specs.ts
│   │   └── 008_create_spec_references.ts
│   └── queries/
│       ├── paragraphs.ts # insertTree(tree, specId, pool) → paragraphIdMap  (new)
│       └── refs.ts       # insertRefs(refs, paragraphIdMap, pool) → void  (new)
scripts/
└── load-ufgs.ts          # bulk loader: DIVISION_*/**.SEC → parse → persist
tests/
└── fixtures/
    └── sec/
        ├── 27_10_00.SEC  # complex fixture (deep nesting, many refs)
        └── 27_41_00.SEC  # simple fixture (fewer parts)
```

**Module boundary:** `src/parser/` has zero DB imports. It returns `CsiTree` + `SecReference[]`. All persistence happens in `scripts/load-ufgs.ts` and (later) the `POST /parse` handler. This matches the module boundary rule in CLAUDE.md.

---

## Database Schema

### Migration 005 — specs unique constraint (amends migration 002)

```sql
ALTER TABLE specs ADD CONSTRAINT specs_section_source_unique UNIQUE (section, source);
```

Required for idempotent upsert in the bulk loader. Added as migration 005; original migrations 005–007 shift to 006–008.

### Migration 006 — projects

```sql
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
```

### Migration 006 — project_specs (TOC junction)

```sql
CREATE TABLE project_specs (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  spec_id    UUID REFERENCES specs(id)    ON DELETE RESTRICT,
  position   INTEGER NOT NULL,
  added_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, spec_id)
);
```

`ON DELETE RESTRICT` on `spec_id` — a spec cannot be deleted while it belongs to a project. TOC removal (deleting the `project_specs` row) is the intentional gate.

### Migration 007 — spec_references

```sql
CREATE TABLE spec_references (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_spec_id      UUID NOT NULL REFERENCES specs(id)      ON DELETE CASCADE,
  source_paragraph_id UUID NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  target_type         VARCHAR(20) NOT NULL,  -- 'section' | 'paragraph' | 'standard'
  target_spec_section VARCHAR(20),           -- e.g. "09 91 00"
  target_spec_id      UUID REFERENCES specs(id)      ON DELETE SET NULL,
  target_paragraph_id UUID REFERENCES paragraphs(id) ON DELETE SET NULL,
  standard_code       TEXT,                  -- e.g. "ASTM C150"
  reference_text      TEXT NOT NULL,         -- verbatim text from source paragraph
  is_broken           BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON spec_references (source_spec_id);
CREATE INDEX ON spec_references (target_spec_id);
CREATE INDEX ON spec_references (target_spec_section);
CREATE INDEX ON spec_references (is_broken) WHERE is_broken = true;
```

`target_spec_id` is resolved at insert time if the target section already exists in `specs`. NULL = unresolved (target not yet loaded) or broken (target was removed). `is_broken` is set explicitly — it distinguishes "not yet loaded" (false) from "was there, now gone" (true).

---

## Data Flow

### Parse phase (`parser/sec/index.ts`)

```
.SEC file bytes
  → detect windows-1252 encoding → re-encode to UTF-8
  → fast-xml-parser (attributeNamePrefix: '', ignoreAttributes: false)
  → raw JS object
  → extract root.SEC.SCN  → section (e.g. "SECTION 27 10 00" → "27 10 00")
  → extract root.SEC.STL  → title
  → extract root.SEC.DTE  → date (stored in spec meta)
  → walk root.SEC.PRT[]
       → CsiNode { type: 'part', text: stripped TTL, children: [] }
       → walk SPT[]
            → CsiNode { type: 'article', text: stripped TTL }
            → walk TXT[] (depth attr → pr1..pr5)
                 → CsiNode { type: 'pr1'|…|'pr5', text: content }
       → walk NTE[] anywhere
            → CsiNode { type: 'note', vanish: true, text: NPR content }
  → assign UUID to every node (uuidv4 — fresh per parse run; tests assert format not value)
  → return CsiTree { id, section, title, parts }
```

### Reference extraction phase (`parser/sec/refs.ts`)

```
CsiTree + raw XML
  → scan all <REF>/<RID> blocks
       → SecReference { targetType: 'standard', standardCode: 'ASTM C150', ... }
  → walk all paragraph text nodes
       → regex /[Ss]ection\s+(\d{2}\s\d{2}\s\d{2}(?:\.\d+)?)/g
            → SecReference { targetType: 'section', targetSpecSection: '09 91 00', ... }
       → regex /paragraph\s+([\d]+\.[\d]+)/gi
            → SecReference { targetType: 'paragraph', referenceText: '...', ... }
  → return SecReference[]

Note: extraction failures are non-fatal — log warning, skip, continue. A missed ref
is better than a failed import.
```

### Bulk loader (`scripts/load-ufgs.ts`)

```
glob('docs/references/UFGS/DIVISION_*/**.SEC')
  → sequential (not parallel) — avoids DB connection pool exhaustion
  → for each file:
       read bytes → parseSec(xml) → CsiTree
       extractRefs(tree, xml) → SecReference[]
       BEGIN transaction
         upsertSpec({ section, title, source: 'ufgs' }) → specId
           (upsert on section — re-running loader is idempotent)
         insertTree(tree, specId, pool) → paragraphIdMap
         resolveRefTargets(refs, pool)  → resolve target_spec_id where section exists
         insertRefs(refs, paragraphIdMap, pool)
       COMMIT
       console info: "✓ 27 10 00  142 nodes  18 refs"
  → final: "Loaded 666 specs, 94,302 paragraphs, 11,847 refs (3 failed: [list])"
  → exit 1 if any failures
```

Idempotent upsert on `(section, source)` — safe to re-run after adding new UFGS files.

---

## Error Handling

```typescript
// parser/error.ts
export class ParserError extends SpecrError {}

// parser/sec/index.ts
try {
  return parseXml(xml)
} catch (err) {
  throw new ParserError('failed to parse SEC XML', { cause: err })
}

// missing required elements
if (!root.SEC?.SCN) {
  throw new ParserError('SEC file missing <SCN> section number element')
}

// unknown TXT depth — log and treat as pr5 (deepest), never throw
if (depth > 5) {
  logger.warn({ depth, file }, 'unexpected TXT depth — clamping to pr5')
}
```

Ref extraction: all errors caught internally, logged at `warn` level, skipped. Never propagates.

Bulk loader: per-file `try/catch` around transaction. Failed files accumulate in `failures[]`, logged at end. Exit code 1 if `failures.length > 0`.

---

## Testing

### Unit tests (`tests/unit/parser/sec/`)

All tests use inline XML strings — no file I/O, no DB.

| Test | Assertion |
|------|-----------|
| `parseSec: extracts section number` | `tree.section === '27 10 00'` |
| `parseSec: extracts title` | `tree.title === 'BUILDING TELECOMMUNICATIONS...'` |
| `parseSec: PRT→SPT→TXT depth nesting` | 7-level hierarchy, correct node types |
| `parseSec: NTE paragraphs vanish:true` | specifier notes preserved, not discarded |
| `parseSec: strips numbering from text` | "PART 1   GENERAL" text → "GENERAL" |
| `parseSec: windows-1252 encoding` | `é`, `–`, `"` characters survive round-trip |
| `parseSec: missing SCN throws ParserError` | error boundary |
| `parseSec: TXT depth > 5 clamps to pr5` | resilience, no throw |
| `extractRefs: REF block → standard refs` | ASTM/UFC codes extracted |
| `extractRefs: section number in text` | "See Section 09 91 00" → targetSpecSection |
| `extractRefs: malformed ref → skipped` | non-fatal, returns partial array |

### Integration tests (`tests/integration/parser/sec/`)

Real PostgreSQL, real .SEC fixture files.

| Test | Assertion |
|------|-----------|
| `load 27 10 00 → paragraph count matches` | full tree persisted |
| `load 27 10 00 → spec_references rows exist` | refs extracted and inserted |
| `load 27 10 00 + 09 91 00 → cross-spec target_spec_id resolved` | FK resolution |
| `load-ufgs idempotent → re-run produces same row count` | upsert correctness |
| `migration 005–007 → tables exist with correct columns` | migration runner |

### Fixtures

```
tests/fixtures/sec/
  27_10_00.SEC   # complex: deep nesting, cross-refs, many NTE blocks
  27_41_00.SEC   # simple: 3 parts, few refs
```

Both copied from `docs/references/UFGS/DIVISION_27/`. Binary-exact copies — no modification.

---

## LOC estimate

| File | Est. lines |
|------|-----------|
| `parser/sec/index.ts` | ~150 |
| `parser/sec/elements.ts` | ~60 |
| `parser/sec/refs.ts` | ~80 |
| `parser/index.ts` | ~30 |
| `parser/error.ts` | ~10 |
| `db/migrations/005–007` | ~80 |
| `db/queries/paragraphs.ts` (additions) | ~60 |
| `db/queries/refs.ts` | ~50 |
| `scripts/load-ufgs.ts` | ~100 |
| Tests (unit + integration) | ~250 |
| **Total** | **~870** |

Over the 500 LOC PR limit. Split options:
- **PR A:** migrations 005–007 + parser module (no loader) — ~480 LOC
- **PR B:** bulk loader + integration tests — ~390 LOC

Recommended split: PR A first (parser is independently testable), PR B immediately after.
