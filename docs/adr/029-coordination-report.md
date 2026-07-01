# ADR-029: Project Coordination Report — Aggregated Findings

## Status

Proposed (Phase 4 — Track B design gate). Implements the core of #105 (errors-and-omissions
view per project), consuming the ADR-028 `required_sections` substrate. No endpoint code lands
until this ADR merges.

**Amended by [ADR-043](043-present-not-required-empty-toc.md) (2026-07-01):** the empty-required
suppression below ("Empty required list ⇒ suppress `present_not_required`") is **reversed** —
`present_not_required` is now emitted for every present spec even when no TOC is authored, with a
reworded note. All other decisions in this ADR stand.

## Context

A CSI MasterFormat project manual diverges from reality in ways that are individually
detectable today but have no single home. ADR-028 landed the missing piece — authored
`required_sections` (the *intent*) held independently of `project_specs`/`package_specs` (the
*reality*). With intent and reality both first-class, the gaps between them — and between
either and the project's cross-references — become a closed, computable set.

#105 envisions five finding classes. Only three have a backing on `main` today:

| Class | Substrate | v1 |
|---|---|---|
| Required-but-absent | `required_sections` (ADR-028) ∖ present | ✅ |
| Present-but-not-required | present ∖ `required_sections` | ✅ |
| Dangling cross-reference | `spec_references.is_broken` (ADR-024) refined by required | ✅ |
| Unmapped Revit elements (#103) | no model-element registry exists — `revit.ts` holds parameter *mappings* only | ✗ defer |
| Keynote orphans (ADR-016) | ADR-016 is Proposed: zero schema, zero code | ✗ defer |

Parse-warning / inference-conflict findings (#56) have a partial backing (`paragraphs.conflicts`)
but pull in a second data domain; they are deferred with the other two. The buildable core is one
coherent domain: the **`required_sections` ↔ TOC ↔ references** triangle.

A 2026-06-11 plan (the deleted-mockup-era `mighty-floating-unicorn` design) sketched this report
as a single 383-LOC CTE that *also* built `required_sections`. That substrate now exists separately
and richer (ADR-028). Per ADR/roadmap-first, the island sketch is an **input to this design, not the
design.**

## Decision

Add a **read-only, computed-on-demand coordination report** that aggregates typed *findings* over
existing substrate at request time. **No new table** — findings are derived, advisory, and cheap to
recompute; the issue places auto-remediation and persistence out of scope.

### Finding model — an open discriminated union

The report returns a list of `Finding`, a discriminated union keyed on `type`. v1 emits three
variants; deferred classes are added later as **new `type` literals only** — additive, never a
breaking change. This union *is* the extensibility contract this ADR locks.

```ts
type Finding =
  | { type: 'required_not_present'; section: string; title: string | null; requiredId: string }
  | { type: 'present_not_required'; section: string; specId: string; title: string }
  | { type: 'dangling_ref'; refId: string; sourceSpecId: string; sourceSpecSection: string;
      targetSpecSection: string; referenceText: string;
      availableFrom: { libraryId: string; name: string }[] }

interface CoordinationReport {
  projectId: string
  packageId: string | null          // null = project scope
  findings: Finding[]
  summary: { requiredNotPresent: number; presentNotRequired: number; danglingRef: number; total: number }
  notes: string[]                   // scope-level advisories, e.g. empty-required suppression
}
```

Each finding carries enough context to act (a section, a spec id, or a ref + its remediation hint) —
the issue's second acceptance criterion.

### Build strategy — compose existing queries in TypeScript

Read the three inputs — required (`listRequiredSections`, ADR-028), present
(`project_specs`/`package_specs` ⋈ `specs`), and broken refs (`getBrokenRefs`, ADR-024) — inside a
single `REPEATABLE READ` transaction for a consistent snapshot, then compute the finding sets in
small (≤50-line) TypeScript functions. This maximises reuse of tested queries, inherits
`getBrokenRefs`'s `availableFrom` enrichment for free, and keeps each finding class independently
testable. (A single mega-CTE and a materialized findings table were both rejected — see
Alternatives.)

### Semantics

- **`dangling_ref` = `is_broken` ∖ required.** `is_broken` means "section-targeted ref whose target
  is not a present project spec" (ADR-024 / `derive.ts`). A ref pointing at a **required-but-absent**
  target is therefore broken-but-intended: it is reported once as `required_not_present`, and
  **excluded** from `dangling_ref`. Only refs whose target is in *neither* present nor required are
  dangling. The existing `GET /projects/:id/references/broken` is left untouched as the
  membership-relative view; the two coexist as **distinct questions** (broken = "not in the project";
  dangling = "in nobody's intent"). Reconciling the two counts in the UI is Phase 5, out of scope here.
- **Scope.** Project scope diffs the **baseline** required rows (`package_id IS NULL`) against
  `project_specs`. `?packageId=` diffs **that package's island** required rows against `package_specs`
  — package-level required only, **never unioned** with the baseline (consistent with ADR-028's
  snapshot model). `getBrokenRefs` remains project-grained; at package scope, dangling refs are
  intersected with the package's present source specs.
- **Empty required list ⇒ suppress `present_not_required`** and push a `notes[]` entry.
  **~~Superseded by [ADR-043](043-present-not-required-empty-toc.md):~~** the suppression made the
  category read as broken for unauthored-TOC projects, so `present_not_required` is now emitted for
  every present spec (with a reworded note). `required_not_present` is still trivially empty when
  `required` is empty; `dangling_ref` still runs (`is_broken ∖ ∅`).
- **`present_not_required` is emitted per present spec** (carrying `specId`), not deduped by section —
  the finding must say *which* document is unaccounted-for.

### Delivery & error mapping

- `GET /projects/:id/coordination-report[?packageId=]` → `ApiResponse<CoordinationReport>`. Malformed
  `:id` or `?packageId` → **400** (matching the sibling `required-sections` handler — `z.uuid()` on an
  identifier is a 400, not a body-validation 422); unknown project, or `packageId` not in the project →
  **404**; else the module error mapping (`DatabaseError` → 500). No stack traces leave the process.
- MCP `coordination_report` tool (`{ projectId, packageId? }`, `z.uuid()`), read-only, **never throws**
  — returns `{ isError: true, content }` on failure, JSON text content on success.
- `openapi.yaml` gains the path plus `CoordinationReport` / `Finding` / `CoordinationFinding*` schemas
  in the same PR (ADR-026 contract gate); OpenAPI 3.1 nullable as `type: [..., 'null']`.

## Consequences

- **#105's core ships now** without waiting on #103 or ADR-016 — the deferred classes slot into the
  same union when their substrate exists, with no contract change for existing consumers.
- **No duplicated ref logic.** Dangling reuses `is_broken`; the report adds required-awareness as a
  subtraction rather than a parallel ref-walk. `/references/broken` and the report stay consistent by
  construction (one derives from the other).
- **A required-but-absent section appears exactly once** (as `required_not_present`), never doubly as a
  dangling target — the empty-set edge and the de-requirement edge both fall out of the set algebra.
- **Read-only and stateless:** no migration, no write path, no cache to invalidate. The cost is
  recomputation per request, which is negligible at project scale and acceptable for an advisory view.
- **Bounded surface:** one query module + one REST handler + one MCP tool + `openapi.yaml`. Fits one
  ≤~300-LOC implementation PR.

## Alternatives considered

- **Materialized findings table.** Rejected — findings are derived and cheap; persisting them adds a
  write path, staleness, and invalidation for advisory data the issue explicitly scopes as read-only.
- **Single mega-CTE** (the island's 383-LOC query). Rejected — re-walks references instead of reusing
  the tested `is_broken` substrate, is hard to unit-test per finding class, and strains the 50-line /
  400-line caps. The TS-composition approach is more reusable and testable for a trivial round-trip cost.
- **Reuse `getBrokenRefs` verbatim as the dangling finding.** Rejected — it would flag every
  required-but-absent target as dangling, double-counting it against `required_not_present` and
  contradicting the report's own advice ("add this required section" *and* "this ref is dangling").
- **Fold `/references/broken` into the report.** Rejected — they answer different questions; removing
  the membership-relative endpoint would break the existing demo masthead and lose the simpler view.
- **Ship all five #105 classes now.** Not viable — unmapped-Revit (#103) and keynote-orphan (ADR-016)
  have no substrate; the open union defers them at zero future cost.

## Related

- ADR-028 (`required_sections` substrate — the intent set this report diffs), ADR-024 (reference
  traversal / `is_broken` semantics), ADR-015 (D2 snapshot independence, D4 `package_specs`),
  ADR-020 (section-number expanded shape), ADR-023 (visible-not-hidden), ADR-026 (OpenAPI contract gate),
  ADR-010 (MCP read-only tools).
- Issues: #105 (this report — tracking/consumer), #84 (Revit required-sections writer — upstream of a
  future finding class), #103 (unmapped Revit elements — deferred class), #56 (parse/inference
  warnings — deferred class), ADR-016 (keynote orphans — deferred class).
