# ADR-078: frozen revision comparison sources

## Status

Accepted

## Context

\#392: the comparison matrix users need spans time as well as scope. ADR-047
shipped `POST /reports/compare` for exactly two **live** `specs` rows and
explicitly deferred frozen `package_revision_specs.tree` snapshots as a
non-goal — they carried no per-node `origin_paragraph_id`, and a
revision/package id simply isn't a `specs` row, so it 404ed at the existence
guard with no special-casing needed. ADR-053 then shipped a **structural**
alignment fallback (`nodeType:ordinal` root-to-node path) for
independently-ingested specs that share no origin — and that fallback needs
only `nodeType`/`parentId`/`position`, all of which a frozen `SpecTree` JSONB
already carries. Better still, two snapshots of the **same package**
(revision↔revision) freeze the same live paragraph UUIDs, since
`SpecNodeSchema` nodes carry `id: z.uuid()` verbatim — same-package
comparisons can align on raw ids natively, no new alignment engine required.

So the real gap was never the aligner (`alignTrees`, source-blind since
ADR-053) — it was the **loader**. This ADR lifts ADR-047's frozen-tree
non-goal by adding a second loader that reads a `package_revision_specs.tree`
snapshot instead of live `paragraphs` rows, and flattens it into the same row
shape the live loader already produces.

A pre-implementation spike built the polymorphic request schema, the frozen
flattener, the dedicated JOIN query, and the report.ts rewrite against real
fixtures (a spec frozen into two revisions of one package, and a mixed
live+frozen pair) before this design was finalized. It confirmed every struct
and interface below as originally reasoned — zero corrections were needed at
that level, an unusual outcome recorded explicitly because it's the exception,
not the rule, for this repo's ADRs (contrast ADR-077, which retracted a "no
migration" claim mid-spike). The spike surfaced exactly one **mechanical**
correction (§13, `src/db/index.ts`'s file-budget headroom) and one
**empirical upgrade** of a reasoned decision into a proven one (§6).

## Decision

### 1. `CompareSource` is a discriminated union, not a new request shape

`type CompareSource = string | { readonly revisionId: string; readonly specId: string }`
(`src/reporting/types.ts`). A bare UUID is the original, back-compat live-spec
shape; an object names the frozen tree of one spec within one issued package
revision. `CompareRequestSchema.sources` becomes
`z.array(CompareSourceSchema).length(2)` — still exactly two, still additive:
every existing all-live request is unchanged wire-for-wire.

### 2. Distinctness uses a canonical key, not raw-value `Set`

Two structurally-identical frozen object literals are never `===`, so a raw
`new Set(sources)` fails to dedupe `[{revisionId: A, specId: X}, {revisionId:
A, specId: X}]`. `sourceKey` (`live:<uuid>` / `frozen:<revisionId>:<specId>`)
gives distinctness a stable identity, checked by the named predicate
`checkDistinctSources` in `CompareRequestSchema.superRefine`. This also makes
a **legal** case fall out for free: a live source and a frozen source of the
*same* underlying spec key differently (`live:X` vs. `frozen:A:X`), so
"compare a live spec against one of its own past issuances" is accepted, not
rejected as a self-comparison — spike-verified both branches directly (two
identical frozen objects rejected; live-X + frozen{X} pair accepted).

### 3. `baseline` resolves against a source's underlying specId, and ambiguity is rejected, not resolved

`sourceSpecId(source)` returns the live spec a source's content traces back
to (the bare string itself, or the frozen object's `specId`). `baseline` is
matched against `sourceSpecId` for each source, not literal array
membership — because a frozen source's wire shape is always an object, never
a bare UUID, `baseline` could never match one directly otherwise. The named
predicate `checkBaselineMatchesExactlyOne` requires **exactly one** match: zero
(typo/unrelated id) and two-or-more (the same spec frozen at two different
revisions, or live-and-frozen of the same spec) are both rejected via 422,
never silently resolved to "the first match". The spike ran the rewritten
`superRefine` orchestration through `pnpm lint` and confirmed zero
cognitive-complexity issues, so no further extraction beyond the two named
predicates (`checkDistinctSources`, `checkBaselineMatchesExactlyOne`) was
needed.

**REST/MCP asymmetry, called out explicitly so it doesn't surprise a future
reader:** the MCP `compare_specs` tool's `inputSchema` is a `ZodRawShape`
(`src/mcp/tool-registry.ts`'s contract), which cannot host a cross-field
`superRefine` the way a full `ZodObject` schema can. Its `sources.refine` only
rejects non-distinct sources; a `baseline` matching more than one source is
**not** rejected there — the tool silently uses the first matching source in
request order and documents this explicitly in its description
(`report-tools.ts`'s `COMPARE_DESCRIPTION`, pinned by
`report-tools.test.ts`). This is a genuine behavior gap between the two
surfaces, accepted as the cost of the `ZodRawShape` constraint rather than
building a second validation path to reject it identically — an agent caller
is told to list its intended baseline source first when the overlap is
possible.

### 4. `getFrozenComparisonSource` is a dedicated JOIN, not a `getPackageRevision` reuse

`src/db/queries/reporting.ts` adds one query:

```sql
SELECT prs.tree, pr.label AS "revisionLabel"
FROM package_revision_specs prs
JOIN package_revisions pr ON pr.id = prs.revision_id
WHERE prs.revision_id = $1 AND prs.spec_id = $2
```

`getPackageRevision` fetches every member spec's tree plus a
nomenclature-profile lookup — overfetch of O(package size) for a single-spec
read, and an unwanted dependency on machinery this loader has no other reason
to need. `getFrozenComparisonSource` returns `null` for both "revision
doesn't exist" and "revision exists but specId was never one of its frozen
members" — the caller (`resolveFrozenSource` in `report.ts`) doesn't need the
two causes told apart, so one `SpecNotFoundError` names both
`revisionId`/`specId`. Spike-confirmed: both null branches return correctly
from the one JOIN with no special-casing.

### 5. `ComparisonColumn` gains `revisionId`/`revisionLabel`, additive and mutually present

```ts
export interface ComparisonColumn {
  readonly specId: string;
  readonly section: string;
  readonly title: string | null;
  readonly revisionId?: string;
  readonly revisionLabel?: string;
}
```

Present iff the column was resolved from a frozen source; a live column
carries neither (omitted, never a null placeholder) — spike-confirmed
invariant, pinned by `types.test.ts`/`reporting.integration.test.ts`.
`revisionLabel` is deliberately the raw `package_revisions.label` column, not
a nomenclature-resolved `displayName` — keeps the reporting loader
independent of the nomenclature-profile machinery, which is unrelated
domain logic this comparison feature has no reason to pull in. If a caller
wants the resolved display form, it already has `revisionId` to look it up
via the existing revisions endpoint.

### 6. Same-package alignment needs no embedded `originParagraphId` — proven, not just reasoned

`SpecNodeMeta.originParagraphId?: string` (`src/ast/types.ts`, mirrored into
`SpecNodeMetaSchema` — see §7) is written only by `snapshotMemberTrees` at
revision-freeze time, stamping each frozen node with the live paragraph UUID
it was built from. **It is needed only for the forward-compat cross-lineage /
cross-project case** — comparing frozen trees whose specs share no lineage,
where the frozen JSONB alone (`id`, `parentId`, `nodeType`, `position`) gives
no cross-tree link at all.

It is explicitly **not** needed for the common case this issue exists to
serve: two revisions of the **same package**. A same-package snapshot freezes
the same live paragraph UUIDs verbatim as its `SpecNode.id`, so
`flattenSpecTree`'s output already carries a real, shared identity across the
pair with zero extra fields. The spike proved this end-to-end rather than
merely reasoning it: froze one spec into two revisions of one package,
flattened both trees, ran `alignTrees` with `alignment: 'auto'`, and got
`alignedBy: 'origin'` with every row aligned — while asserting neither frozen
tree's serialized JSON contained the string `"originParagraphId"` at all. A
future reader must not assume the field is load-bearing for the common case;
it exists purely to widen the alignment surface for a comparison this ADR
does not yet build a loader-side test fixture for.

### 7. `SpecNodeMetaSchema` mirrors `originParagraphId` in the same commit

`SpecNodeMetaSchema` has no `.catchall()`, so a field added to the
`SpecNodeMeta` TS type but not mirrored into the Zod schema silently vanishes
on the next JSONB round-trip rather than failing loud — the exact failure
mode PR #536 hit for `pageSize`. `originParagraphId: z.uuid().exactOptional()`
lands in the same commit as the type addition (`f63fb33`), non-negotiably,
per that precedent.

### 8. `originParagraphId` embedding is scoped strictly to freeze time

`revision-snapshot.ts`'s `paras` `SELECT` gains
`origin_paragraph_id AS "originParagraphId"` as a **local** row-type addition
(`SnapshotParagraphRow extends ParagraphTreeRow`) — `ParagraphTreeRow` and
`buildNodeTree` (`specs.ts`) are untouched, so the live `GET /specs/:id/tree`
path never selects this column and never carries the field. `embedOriginIds`
walks the tree `buildNodeTree` already produced and stamps
`meta.originParagraphId` from a `Map<paragraphId, originId | null>`, omitting
the key entirely when the source paragraph carries no lineage (never
`null` — matches the existing conditional-spread idiom for optional `meta`
fields under `exactOptionalPropertyTypes`). Spike-confirmed zero blast radius
on the live tree endpoint.

### 9. The frozen flattener is pure and lives outside the pg-import boundary

`src/reporting/frozen-tree.ts` exports `flattenSpecTree(tree, specId)`,
producing the same `ComparisonParagraph` row shape the live DB loader emits,
so `alignTrees` treats a frozen column exactly like a live one with no
branching in the aligner itself. It is named `frozen-tree.ts`, not
`frozen-loader.ts`, specifically to signal it does no I/O and imports no
`pg` — `src/reporting/`'s existing boundary rule.

`position` is a per-parent DFS visitation index recomputed from the stored
children-array order, because a frozen tree carries no absolute DB `position`
column. This only needs to preserve sibling **order**, not reproduce the live
loader's raw integers: `computeStructuralKeys` (`structure.ts`) derives its
ordinal from same-`nodeType` sibling counts, which is invariant to
renumbering as long as relative order is kept. Spike-confirmed
byte-identical `computeStructuralKeys` output vs. the live DB-position loader
for an unedited spec, verified at per-node-id equality (not merely
structural equivalence by argument shape).

Owner-removed subtrees (`vanish === true`, non-`note`) are excluded before
position assignment, matching the live loader's recursive-CTE removal
semantics exactly — parity with merge/render (ADR-047).

### 10. Report orchestration moves to positional per-source resolution

`specId` is no longer a safe whole-request identity key once a source can be
live once, frozen once, or the same spec frozen at two different revisions.
`buildComparisonReport` therefore resolves `sources.map(resolveSource)`
**positionally** rather than de-duplicating by specId: `resolveLiveSources`
batch-loads every live (bare-uuid) source in one round trip each, and
`resolveSource` dispatches each source in request position — live sources
read from the pre-loaded maps, frozen sources fetch their own single-row
snapshot (not worth batching). Spike-confirmed this rewrite is
behavior-preserving for the fully-live path: the pre-existing 9-test
`reporting.integration.test.ts` suite passed **unmodified** against the
rewritten orchestration, including the exact not-found error-message string.

### 11. Drift stays scoped to the live bucket only

`computeDrift` walks only the live sources actually requested
(`liveOrderedMetas`) — a frozen source is a point-in-time tree snapshot with
no lineage chain of its own to walk. It is omitted from the response's
`drift` array entirely for an all-frozen or mixed pair's frozen column,
never faked with a zero or null placeholder.

### 12. No migration

`originParagraphId` rides inside the existing `package_revision_specs.tree`
JSONB (migration 021) via the additive `SpecNodeMeta`/`SpecNodeMetaSchema`
field — no new column, no new migration, matching ADR-077's `pageSize`
precedent for JSONB-payload-only additive fields (as distinct from
ADR-077's *other* field, `specs.page_size`, which did need a dedicated
column because it lived outside any existing whole-tree JSONB payload).
Migration slot 054 was reserved during planning and stays unused; the next
migration to land takes that number.

### 13. Spike correction: `db/index.ts`'s two new barrel exports must be single-line

`src/db/index.ts` sits close enough to eslint's counted `max-lines: 400`
(this repo's override of the global 800; `skipBlankLines`/`skipComments`
semantics, which diverge from raw `wc -l`) that the file's existing
4-line-per-export block style — one line each for the named export, the
`export type`, and blank/comment spacing — would tip it over budget for two
new barrel-export additions. Both new exports for this issue are written as
single-line statements instead:

```ts
export { getFrozenComparisonSource } from './queries/reporting.js';
export type { FrozenComparisonSource } from './queries/reporting.js';
```

and two pre-existing multi-line export pairs (`getBrokenRefs`/`BrokenRef`,
`getProjectKeynotes`/`ProjectKeynote`) were collapsed into their own
single-line `export { fn, type T } from '...'` forms in the same commit to
buy back enough headroom — a mechanical fix, not a design change, but one
that must be honored by any future addition to this file or CI's lint gate
goes red on a file this issue only touches incidentally.

## Non-goals (reaffirmed from ADR-047/053, still standing)

- **A package or revision id is still never a `specs` row.** Only an explicit
  `{revisionId, specId}` object resolves a frozen source; passing a bare
  package or revision UUID as a source is treated as an (invalid) live-spec
  UUID lookup and 404s at the same existence guard as before — the
  non-goal continues to enforce itself with no special-casing.
- **No fuzzy/content-based alignment.** This ADR adds a second *loader*
  (frozen vs. live), not a third alignment mode — `alignTrees` stays
  source-blind and deterministic, per ADR-053.
- **No backfill of pre-existing snapshots.** Revisions frozen before this
  change lack `meta.originParagraphId` and simply degrade to structural
  alignment for the (out-of-scope today) cross-lineage frozen case; §6
  established this doesn't affect the same-package case at all.

## Sharp edge (pre-existing, flagged not fixed)

`sameSection` (`align.ts`) treats any two columns whose `tree.section` values
are equal as alignment candidates for the structural fallback, including the
literal sentinel value `'unknown'` that `infer-section.ts` assigns when
section inference fails. Two **unrelated** specs that both fell back to
`'unknown'` would structurally-align under `alignment: 'auto'`/`'structure'`
even though they share no real section — a pre-existing gap that predates
this ADR and applies equally to two live specs. It is called out here,
rather than fixed, because frozen comparison makes it more likely to surface
in practice: an older package snapshot is more likely to have been frozen
before a section-inference improvement landed, so a `'unknown'`-sectioned
frozen column may now be compared against a live column whose section has
since been corrected. Out of scope for #392; worth a follow-up issue if it
causes a real false-positive alignment in practice.

## Consequences

- `POST /reports/compare` and the `compare_specs` MCP tool accept a live
  spec, a past issuance of any package member, or a mix of the two — "what
  changed since we issued", "what changed between two issuances", and the
  original "what changed between two live specs" are all one endpoint, with
  the wire format for the original case byte-for-byte unchanged.
- `ComparisonColumn.revisionId`/`revisionLabel` make every returned cell
  traceable to *which issuance* it came from whenever the source is frozen,
  without adding any nomenclature-profile dependency to the reporting
  loader.
- `originParagraphId` starts accumulating on every new revision freeze going
  forward (§6/§8), at zero cost to the same-package comparison path that
  #392 exists to serve, laying groundwork for a future cross-lineage
  frozen-comparison loader without committing to build it now.
- The REST and MCP surfaces diverge on baseline-ambiguity handling — 422
  reject vs. silent first-match — a deliberate, documented consequence of
  the MCP `ZodRawShape` input-schema constraint (§3), not an oversight.
- No migration; no change to any existing live-spec or already-frozen
  revision's stored data. A pre-#392 snapshot compares exactly as it would
  have before this change (structural alignment only), per the non-goals
  above.
