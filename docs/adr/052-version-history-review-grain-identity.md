# ADR-052: Paragraph Version History, Review Grain, and Actor Identity

## Status: Partially Accepted

Accepted (D6 — users, fully implemented in #381). D7 (role_assignments) —
schema Accepted in #381 (migration 045); query/API/MCP layer lands in the
immediate follow-up PR. D1-D5, D8-D9 remain Proposed, pending #377/#380/#382.

Drafted 2026-07-06 from the version-history brainstorm (issues #377, #378, #379,
#380, #381, #382). Review before implementation begins; the decision register
below is the contract for that program. Supersedes nothing; extends ADR-005 and
ADR-015, unblocks ADR-011.

## Context

The product goal: walk a spec — and any single paragraph — through every
iteration from its original master version, across package issuances (addenda,
bulletins, RFIs, CCDs — revision types per the #209 nomenclature), to its
current state, and visualize that in an editor (#379).

What exists today is fragmentary:

- `paragraph_versions` (migration 004) snapshots text **only on merge apply**
  (`src/merge/conflict.ts`). A WYSIWYG blur-save, an insert (#372), a
  reversible removal (#251) — all bump versions without recording prior state.
  History for ordinary editing does not exist.
- Three timeline anchors already exist and are underused: the master's
  `origin_version` at the derive point (ADR-015), the per-spec
  `content_version` (bumped on every content write, ADR-018), and package
  revisions — **immutable full-SpecTree JSONB snapshots** at issuance
  (ADR-015 D5).
- There is no actor identity anywhere: no users table, no attribution on any
  write. The advisory soft lock (ADR-018 D2) stores a free-text `holder` and
  is not consulted by the edit gate — it stops nobody.
- The branch structure the domain needs already exists **structurally**:
  copy-on-derive (ADR-015) makes a company master a trunk, a project copy a
  branch cut at the derive point, and issuances tags on that branch. What is
  missing is the commit-grain layering *within* each track.

Two forces shape the design:

1. **Edit drift.** Tracking every blur-save means a paragraph can accumulate
   1,500 micro-edits (1,499 meaningful revisions, then a period). Raw oplogs
   are unreviewable; 20 editors across hundreds of specs make it worse. Word's
   track-changes points at the answer: changes accumulate as *pending* until
   someone *accepts* them.
2. **The database is not the constraint.** Measured on real data (average
   paragraph text 118 bytes, ~264 paragraphs/spec): 20 heavy editors generate
   ~5k history rows/day ≈ ~1 GB/year firm-wide, all index-friendly. A net diff
   between two anchors compares boundary versions per paragraph —
   O(changed paragraphs), independent of op count. The real problem is
   synthesis and UX, so every noise-reduction mechanism below is a **read-time
   view**, never a write-time compromise.

## Decision register

### D1 — Complete capture, snapshot-first model

Every content write records a history row: text edit, insert (a creation row),
reversible removal and restore, merge apply, accept-comment-as-note, and the
future restructure (#371). The model extends `paragraph_versions`'
snapshot-per-version lineage rather than switching to an event log: each row
carries the full text, node type, an **op kind**
(`edit | insert | remove | restore | merge | accept-note | restructure`), the
spec `content_version` at write time, the actor (D6), and a timestamp.
Structural ops additionally record their delta (type/parent/position) in an
open JSONB payload column. Snapshots keep reads trivial (no replay); op kinds
give event semantics where creation/removal need them. One shared write helper
serves all paths so capture cannot drift per-endpoint.

### D2 — Never squash

The tier-0 oplog is immutable and kept forever. The audit trail is
liability-driven (a firm must prove what a spec said at contract time —
ADR-011's context); destructive collapse is off the table, and no retention
knob ships in v1. All drift-taming happens at read time (D3).

### D3 — Three grain tiers; `content_version` is the join key

- **Tier 0 — oplog** (D1): complete, immutable, surfaced only on drill-down
  (`?raw=true`).
- **Tier 1 — coalesced sessions + checkpoints**: consecutive tier-0 ops by the
  same actor on the same paragraph read as ONE change with a net before→after
  diff, computed at read time. Sessions break when the gap exceeds ~30 minutes
  (server-configurable), at any checkpoint, and at any intervening edit by
  another actor on the paragraph. **Checkpoints** are stored named markers —
  `{scope: spec | project, name, actor, at, content_version map}` — the Word
  "accept changes" moment: everything after the latest checkpoint is
  *pending*; a checkpoint seals it into the reviewed baseline. Markers, not
  mutations.
- **Tier 2 — milestones** (already exist): derive points, package
  issuances/revisions, master re-imports.

Default timeline reads return tiers 1–2 only — a dozen stops, never 1,500.
The spec-grain `content_version` stamped on every history row (D1) is the join
key that keeps paragraph iterations, document timelines, and diffs consistent.

### D4 — Checkpoints are advisory; reject ships in v1

Issuing a package while pending unreviewed changes exist raises a
coordination-style **finding** (ADR-029 vocabulary), never a hard 409 — a hard
gate would be spam-checkpointed into meaninglessness at deadline. Per-paragraph
**reject** (revert pending edits to the last-checkpoint state) ships in v1 as a
restore-to-version write through the existing paragraph PATCH — itself a
history row, so rejection is auditable and reversible like everything else.

### D5 — Timelines start at the derive point; custody crossing is a toggle

A project paragraph's history begins at its derive point ("the starting point
of a project"). `?includeOrigin=true` extends through `origin_paragraph_id`
into the master's pre-derive iterations (rendered under a MASTER divider in
UIs). Cross-custody drift — copy vs. its master *today* — remains ADR-047
`compare_specs` territory; the two views link, they do not merge. History
survival across master re-ingest requires identity-preserving re-ingest
(#375): today's wipe-and-reinsert severs every chain — hard interlock, not
optional.

### D6 — Actor identity: a users table from day one, never bare strings — IMPLEMENTED (#381)

`users (id UUID, label TEXT UNIQUE, created_at)`, migration 045. Shipped as
designed: 3 columns, `label` unique so `resolveOrCreateUserByLabel` is a
race-free upsert (`ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
RETURNING *`) rather than a check-then-insert. `POST /users` resolves-or-creates
by label; `GET /users` and `GET /users/:id` list/read; MCP mirrors 1:1
(`resolve_user` write-tier, `list_users`/`get_user` read-tier). Every history
row, checkpoint, lock, and suggestion branch will reference `users.id` once
D1/D8 land. The claim ladder is unchanged from the original design:
**label-claimed** now (spoofable, stated openly — the ADR-018 `holder` trust
posture), → **externally associated** (Revit `Application.Username` mapped to
a user row so add-in edits attribute), → **SSO-verified** (#43's OAuth flow
*claims* existing rows, so a firm hosting behind SSO inherits all pre-auth
history instead of orphaning it).

### D7 — Roles: scoped assignments, enforcement points built now — SCHEMA IMPLEMENTED (#381), query/API/MCP layer follows

`role_assignments (user_id, scope_type project | library, scope_id, role)` with
the v1 closed vocabulary `viewer | editor | spec-editor | admin`:

| Role | Meaning |
|---|---|
| `viewer` | Read-only reviewer — full visibility, no writes. |
| `editor` | Designer/engineer/architect — normal edits; **diverted** to a suggestion branch during a consistency-review period (D8). |
| `spec-editor` | Consistency-review privileged — canonical writes pass during review mode; approves/rejects branches. |
| `admin` | Lifecycle, checkpoints, issuances, role grants, destructive ops. |

Scoping is per project and per library (masters are their own reviewed track).
Pre-#43 identity is label-claimed, so roles are honor-system — but the
enforcement points (edit gate, divert logic, destructive gating) are built now
so #43 hardens identity without retrofitting authorization. Roles are the
human analog of the MCP capability tiers (ADR-045); the symmetry is
deliberate.

**Storage vs. wire vocabulary.** The `role_assignments` table itself shipped in
issue #381's migration 045, alongside `users` (schema-only; no rows can be written
until the query layer below lands). It stores scope as **two nullable FK
columns** (`project_id`, `library_id`) with an XOR `CHECK`
(`(project_id IS NULL) <> (library_id IS NULL)`), not a single
`scope_type`/`scope_id` pair — the same precedent as
`division_general_specs` (migration 022, ADR pending at the time, now
documented here): a real FK per scope type gets `ON DELETE CASCADE` and
referential integrity for free, where a polymorphic `scope_id` would need an
application-level check no database constraint can enforce. The **API and MCP
wire shape stays `scopeType: 'project' | 'library'` + `scopeId: UUID`** as
originally designed — callers never see the two-column split; the query layer
translates at the boundary (`scopeType === 'project' ? { project_id: scopeId }
: { library_id: scopeId }`).

**Why the split.** #381 shipped the `users` vertical end-to-end (migration,
query layer, `POST/GET /users`, `GET /users/:id`, MCP tools) plus the
`role_assignments` table (schema only, via the same migration 045 — bundling
both tables in one migration is cheap and migrations are excluded from the
lint/LOC budget). The `role_assignments` **query layer, REST resource
(`/role-assignments`), MCP tools, and `lib/roles.ts` (`hasAtLeastRole`)** move
to an immediate same-day follow-up PR. This was not a scope call — it was
forced by `src/db/index.ts`'s ESLint `max-lines: 400` cap (project override,
`CLAUDE.md`): the file measured 395 ESLint-counted lines before this work (5
lines of headroom), and adding both the `users` and `role_assignments`
barrel-export blocks together pushed it to 413, confirmed by running
`npx eslint src/db/index.ts` against the real file — not estimated. Trimming
comments saves nothing (`skipComments`/`skipBlankLines` already exclude them
from the count) and the file is already `prettier --check`'s canonical
minimal-line rendering at `printWidth: 100`, so no formatting trick reclaims
lines. The only two real levers were "add fewer lines" or "split the PR";
`role_assignments`' query/API/MCP surface — the newest, least-depended-on
layer, and the one whose only planned consumer (`hasAtLeastRole`) has zero
callers until it exists — was the cleanest cut.

### D8 — Consistency review: enforced lockout with per-user suggestion branches

A `consistency-review` spec state (distinct from — and unlike — the advisory
ADR-018 D2 lock, actually enforced by the edit gate). During it, writes by
`editor`-role users are not rejected but **diverted** into a persisted
per-(spec, user) **suggestion branch**: paragraph-grained proposed changes
expressed in the merge engine's vocabulary (`modified | added | deleted`
against canonical UUIDs). A branch has exactly the shape of a 3-way diff's
*theirs*, so **approval is a merge apply** (#374) — one reconciliation engine,
not two. Issuance snapshots contain only canonical state, so suggestions
physically cannot leak into an addendum; unapproved branches at issuance raise
an advisory finding (D4). Branches carry an optional, auto-generated **friendly
name** (`<user> — <trigger> — <date>`, owner-renameable) so a user's grouped
work — during a lockout or toward the next addendum after an issuance — is a
nameable thing in the UI. This is deliberately **not** spec-row branching:
change-sets are deltas against canonical UUIDs; ADR-015 custody is untouched.

### D9 — Read surface: anchor-aware, plain wire, MCP in lockstep

Timeline endpoints return tier-1/2 anchors by default; paragraph iterations
return coalesced sessions with raw drill-down; point-to-point diff compares
the two boundary versions per paragraph (`DISTINCT ON`, O(changed
paragraphs)). The wire carries row-level before/after text only — word-level
diff highlighting is client presentation, consistent with ADR-005's refusal to
merge at word level. Pending-change summaries accept `?packageId=` (issuance
deadlines are per-package). Every endpoint ships with its `openapi.yaml`
operation and MCP tool/tier (or reasoned `MCP_UNEXPOSED`) in the same PR
(ADR-044/045).

## Consequences

- **Schema**: `paragraph_versions` gains `op`, `content_version`, `user_id`,
  `payload JSONB` (or a successor table with backfill of the existing merge
  rows); new tables `users`, `role_assignments`, `checkpoints`,
  `suggestion_branches` (+ branch-change rows). Indexes:
  `(paragraph_id, version)` (exists), plus `(spec_id, content_version)` access
  for boundary-version diffs.
- **Write paths**: `updateParagraphText`, `setParagraphVanish`,
  `insertParagraphAfter`, `acceptCommentAsNote`, `applyMerge`, and future
  restructure all funnel history through one helper; merge remains the only
  writer until #377 lands, then becomes one of many.
- **ADR relationships**: extends ADR-005 (base snapshots become universal;
  its `paragraph_versions` design is the seed); unblocks ADR-011 (git sync
  becomes a downstream serializer of this history); ADR-018's advisory lock is
  kept as a courtesy signal but superseded for enforcement by D8's review
  state; ADR-047 keeps cross-custody comparison.
- **Sequencing**: #381 (identity/roles) → #377 (capture) → #380
  (sessions/checkpoints) → #378 (reads) → #379 (Editor UI); #382 rides #381 +
  #374. #375 is a standing interlock for history durability.
- **Known risks**: the 30-minute session window is a heuristic (configurable,
  revisit with usage); long consistency reviews let canonical state drift under
  open branches — the 3-way merge absorbs this by construction (base = branch
  fork point), but conflict-heavy approvals should be measured; actor spoofing
  before #43 is accepted and documented rather than pretended away.
