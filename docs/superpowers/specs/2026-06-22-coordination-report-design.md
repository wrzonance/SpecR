# Spec — Project Coordination Report (ADR-029, core of #105)

**Status:** Design approved (brainstorming, 2026-06-22). Decision-of-record: `docs/adr/029-coordination-report.md`.
**Scope:** a read-only `GET /projects/:id/coordination-report` (+ MCP tool) aggregating the three buildable
TOC-coordination finding classes. Revit-element (#103), keynote-orphan (ADR-016), and parse/inference
(#56) classes are deferred behind the open `Finding` union.
**Phase:** 4 / Track B (second design gate of the demo↔backend conformance roadmap). Consumes ADR-028.

This spec is the *how*; ADR-029 is the *why and what*. Read the ADR first — this document lays out the
implementation blueprint a plan can be written against, it does not re-argue the decision.

---

## 1. Goal

Give spec writers a single errors-and-omissions view per project (and per package): the divergences
between authored **intent** (`required_sections`, ADR-028), the derived **reality**
(`project_specs`/`package_specs`), and the project's **cross-references** (`spec_references`). No new
storage — the report is computed on demand and returned as typed findings.

## 2. No data model change

The report is derived. **No migration.** It reads three existing inputs and computes set differences.
Inputs, all already on `main`:

- **required** — `required_sections` rows at scope (ADR-028): baseline `package_id IS NULL`, or a package's
  island rows. Read via `listRequiredSections(scope, db)`.
- **present** — the scope's derived specs: project scope = `project_specs ⋈ specs WHERE project_id`;
  package scope = `package_specs ⋈ specs WHERE package_id`. Each row contributes `{ specId, section, title }`.
- **broken** — `getBrokenRefs(projectId, db)` (ADR-024): `is_broken` section-refs with their `availableFrom`
  remediation hint. `is_broken ≡ target ∉ present (project membership)`.

## 3. Query layer (`src/db/queries/coordination.ts`, barrelled in `src/db/index.ts`)

One public function, plus small private helpers (each ≤50 lines, ESLint-enforced). Parameterized SQL only.

```ts
type Finding =
  | { type: 'required_not_present'; section: string; title: string | null; requiredId: string }
  | { type: 'present_not_required'; section: string; specId: string; title: string }
  | { type: 'dangling_ref'; refId: string; sourceSpecId: string; sourceSpecSection: string;
      targetSpecSection: string; referenceText: string;
      availableFrom: readonly { libraryId: string; name: string }[] }

interface CoordinationSummary {
  requiredNotPresent: number; presentNotRequired: number; danglingRef: number; total: number
}
interface CoordinationReport {
  projectId: string; packageId: string | null
  findings: readonly Finding[]; summary: CoordinationSummary; notes: readonly string[]
}

getCoordinationReport(
  projectId: string,
  packageId: string | undefined,   // undefined = project scope
  db?: Pool,
): Promise<CoordinationReport>      // throws ProjectNotFound / PackageNotFound (typed)
```

**Algorithm** (one `REPEATABLE READ` transaction for a consistent snapshot):

1. Assert scope exists — project (404 `ProjectNotFound`), and if `packageId` given, that it belongs to the
   project (404 `PackageNotFound`). Reuse the ADR-028 scope-assertion helpers / `findPackageById`.
2. Read `required`, `present`, `broken` (the three inputs above) within the transaction.
3. Build a `Set` of required section codes and a `Map`/`Set` of present section codes.
4. Compute findings as plain TS set differences:
   - `required_not_present` — each `required` row whose `section ∉ present`.
   - `present_not_required` — each `present` **spec** whose `section ∉ required` (per-spec, carries `specId`).
     **Suppressed entirely when `required` is empty** — instead push the empty-required note.
   - `dangling_ref` — each `broken` ref whose `targetSpecSection ∉ required`. At **package scope**,
     additionally restrict to refs whose `sourceSpecId ∈ present` (the package's source specs), since
     `getBrokenRefs` is project-grained.
5. Assemble `summary` (counts + total) and `notes`; return.

Wrap any DB failure in `DatabaseError` with `cause`. Section-code comparison is raw string equality on the
canonical expanded shape (both sides are ADR-020 canonical; if dirty `target_spec_section` ever produces
false positives, normalize via `lib/section-number` — noted, not built).

## 4. API layer (`src/api/coordination.ts`, route in `src/api/router.ts`)

House pattern: validate `:id` with `z.uuid()` (→ 400), optional `?packageId` with `z.uuid()` (→ 400) —
matching the sibling `required-sections` handler, where a malformed identifier is a 400 and 422 is reserved
for body/semantic validation. Typed-error mapping, `ApiResponse<T>` envelope, no `any`, no stack traces out.

| Method & path | Query | Success | Errors |
|---|---|---|---|
| `GET /projects/:id/coordination-report` | `?packageId?` | `200 ApiResponse<CoordinationReport>` | 400 bad `:id`/`packageId`; 404 unknown project or packageId-not-in-project |

`getCoordinationReportHandler` reads `req.query.packageId` (string \| undefined), validates, calls
`getCoordinationReport`, maps `ProjectNotFound`/`PackageNotFound` → 404, else 500 via the error middleware.

### OpenAPI (ADR-026 — same PR)

Add the path + schemas to `openapi.yaml`: `CoordinationReport`, `CoordinationSummary`, and the three
finding schemas as a `oneOf` discriminated on `type` (e.g. `CoordinationFindingRequiredNotPresent`,
`…PresentNotRequired`, `…DanglingRef`). OpenAPI 3.1 nullable as `type: [string, 'null']` (never
`nullable: true` — fails `redocly lint` in CI). Update `RESPONSE_ALLOWLIST` in
`src/api/contract.integration.test.ts` for the new route; the contract gate (route↔spec bidirectional +
response-schema validation) must stay green.

## 5. MCP tool (`src/mcp/handlers.ts` + `src/mcp/tools.ts`)

`handleCoordinationReport({ projectId, packageId? })` → `getCoordinationReport`; **never throws** — returns
`{ isError: true, content }` on null/error (ADR-010 / repo gotcha), JSON text content on success. Register
`coordination_report` with `inputSchema: { projectId: z.uuid(), packageId: z.uuid().optional() }` via a
`registerCoordinationTools(server)` called from `registerTools()`. Import DB functions from `../db/index.js`
only.

## 6. Demo wiring (rides with this work, not the substrate PR)

The demo carries `getCoordinationReport` + a `coordination` feature flag (still `false`). The flag flip and
the coordination panel render are **Phase 5 / examples-only** — they are *not* part of this backend PR.
Leave `coordination: false` here; the panel is tracked separately so we don't advertise UI with no backend.

## 7. Test plan (integration-first, real Postgres)

The issue's acceptance criteria are the spine:

- **One defect of each class → three findings.** Fixture: a project with (a) a required section that has no
  spec, (b) a present spec whose section is not required, (c) a present spec citing a section in neither
  required nor present. `getCoordinationReport` returns exactly one finding of each `type`, each carrying its
  actionable id (section / specId / refId + availableFrom).
- **Dangling excludes required-but-absent.** A ref whose target is required-but-not-present yields
  `required_not_present` only — never `dangling_ref`. (Named regression test — the core set-algebra invariant.)
- **Empty required ⇒** `present_not_required` suppressed + note present; `required_not_present` empty;
  `dangling_ref` still computed.
- **Package scope** diffs package-island required vs `package_specs`, and restricts dangling to the package's
  source specs; baseline required is **not** unioned in.
- **Summary** counts match findings; `total` is their sum.
- **API:** 200 envelope + representative findings; `404` unknown project; `404` packageId-not-in-project;
  `400` malformed `:id`/`packageId`.
- **MCP:** success returns JSON text; unknown project returns `isError: true` (no throw).
- **Contract gate** green.

## 8. Sequencing / chunking

One PR, ≤~300 LOC of real change (excl. `openapi.yaml`): query module → REST handler + route → MCP tool →
`openapi.yaml` → tests, each step keeping the build green. Branch `feat/api-coordination-report` off
`origin/main`. Conventional Commits scoped per module (`feat(db): …`, `feat(api): …`, `feat(mcp): …`).
PR `Closes #105`; references ADR-029. **Execution is gated on ADR-029 (this gate PR) merging first.**

## 9. Out of scope (explicit)

- `unmapped_revit_element` (#103 — no model-element registry exists), `keynote_orphan` (ADR-016 — Proposed,
  no schema), `inference_conflict`/`parse_warning` (#56 — second data domain). All slot into the open union
  later with no contract change.
- Auto-remediation of any finding (issue out-of-scope).
- UI rendering / demo `coordination` flag flip (Phase 5, examples-only).
- Folding `/references/broken` into the report, or changing its semantics (kept as the distinct
  membership-relative view).
- Persisting / caching findings (read-only, recomputed per request).

## 10. Open items for the implementer

1. Confirm the exact present-set query to reuse for `project_specs ⋈ specs` / `package_specs ⋈ specs`
   (a TOC-listing query likely exists in `projects.ts`/`packages.ts`; add a thin scoped helper if not).
2. Confirm the ADR-028 scope-assertion helpers (`assertScopeExists` / `findPackageById`) are reachable
   from `coordination.ts` via the barrel, or factor a shared helper.
3. Pick the OpenAPI representation for the `Finding` union (`oneOf` + discriminator) and verify it passes
   `redocly lint` under 3.1 before wiring the contract test.
4. Confirm `getBrokenRefs`'s row shape (`refId, sourceSpecId, sourceSpecSection, targetSpecSection,
   referenceText, availableFrom`) maps 1:1 to the `dangling_ref` finding after the required-subtraction.
