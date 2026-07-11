# ADR-064: Standards registry — scope, verdict semantics, citation normalization

## Status

Accepted

## Context

The parser already extracts standards-organization references (ASTM, ANSI, NFPA,
…) per paragraph into `spec_references` (`target_type = 'standard'`,
`standard_code` holding the cited string, e.g. `"ASTM C150"`), and the
coordination report already flags a standard cited in the body but missing from
the REFERENCES article (`standard_cited_not_listed`). What the API did not offer
is the standard **itself** as a first-class record: no compiled "every standard
cited across this library/project" list, no place to record its current
published version / source location, and no way for a reviewing client to
persist "verified current on DATE". Issue #446 adds that registry plus the
rollup read model and the write-back verdict.

Three design questions had no obvious answer and are settled here.

## Decision

### 1. The registry is global, not scope-owned

A `standards` row keys on **(`org_code`, `standard_code`)** and is unique on that
pair — one registry record per real-world standard, shared across every library
and project that cites it. A standard's published version and currency status are
facts about the standard, not about a particular project, so scoping the registry
per library/project would duplicate the same verdict everywhere the standard is
cited. The rollup reads (`GET /libraries/{id}/standards`,
`GET /projects/{id}/standards`) are scope-relative — they compile the *citations*
found in that scope — and LEFT JOIN the single global registry row for each cited
standard. Citations stay in `spec_references`; the registry never references them.

### 2. Citation → (orgCode, standardCode) normalization

`spec_references.standard_code` stores the whole cited string (the DOCX extractor
builds it as `` `${org} ${identifier}` ``; the `.SEC` parser stores the RID
verbatim). The rollup and the write path must agree on how that splits into the
registry key, or the JOIN silently misses. The rule (`parseStandardCitation`,
`src/db/queries/standards.ts`):

- Split on the **first run of whitespace**. `orgCode` = the leading token,
  **uppercased and trimmed**; `standardCode` = the remainder, trimmed (case
  preserved — `A653M` vs `a653m` are different identifiers).
- A cited string with **no** whitespace is treated as org-only: `orgCode` = the
  token, `standardCode` = `''`. This is a KNOWN AMBIGUITY (pinned in a test): a
  `.SEC` RID like `"ANSI/TIA-568.1"` cannot be split into org + identifier by
  whitespace. DOCX — the product's fidelity path — always emits `"ORG ident"`, so
  the ambiguity only touches `.SEC` seed data, and the registry simply cannot
  verify such a citation until a client records a verdict against the exact key.

The write path receives `orgCode` / `standardCode` already separated (URL path
params), applies the same uppercase-org normalization, and upserts. Because both
sides normalize identically, a recorded verdict deterministically re-joins to its
citations in the next rollup. `standardCode` may contain reserved URL characters
(a slash in `A653/A653M`); clients percent-encode it in the path.

### 3. Verdict semantics — server stamps `last_verified_at`

`PUT /standards/{orgCode}/{standardCode}` is "a client reviewed this standard;
here is the verdict" — status, current version, source URL, title, notes, all
optional. The server stamps `last_verified_at = now()` on **every** successful
write, because the act of recording a verdict *is* the verification event; the
client never supplies the timestamp. Re-recording refreshes it (idempotent
upsert on the unique key).

### 4. Superseded/withdrawn surfaces as a rollup finding

A cited standard whose registry status is `superseded` or `withdrawn` produces a
finding in the standards rollup (`standard_superseded` / `standard_withdrawn`),
with the citing specs and paragraph anchors, plus summary counts. It is
**not** added to the coordination report in this change — the standards rollup is
the natural home for a registry-derived finding, keeping this feature
self-contained; folding it into `CoordinationSummary` (a shared schema) is a
separate, optional follow-up.

## Consequences

- New reversible migration `043_create_standards.ts`; pure builder
  `src/db/queries/standards.ts` (unit-tested, DB-free) + read/upsert layer
  `src/db/queries/standards-read.ts` (mirrors the ADR-063 reference-graph split).
- Three REST routes + `openapi.yaml`; three MCP tools (`list_library_standards`,
  `list_project_standards` read-tier; `record_standard_verification` write-tier)
  with `contract-map.ts` parity entries (ADR-044) and capability tiers (ADR-045).
- The registry is a thin verdict store, not a standards database: SpecR does not
  fetch currency from any external body. A client (human UI or automated
  workflow) owns the verdict; the API compiles citations and reflects the verdict
  back deterministically.
