# ADR-005: Git-Style 3-Way Merge for Owner Redlines

## Status: Implemented Phase 3c (extract, diff, and merge-apply APIs); `POST /specs/:id/merge` now also applies accepted addition/deletion entries, not just modified/conflict (#374)

## Context

The specification review workflow is:
1. Spec writer generates DOCX from SpecR database
2. DOCX goes to Owner/Client for review
3. Owner redlines the DOCX (adds, modifies, deletes content)
4. Redlined DOCX returns to spec writer
5. Spec writer must reconcile changes back into their master

The naive approach is "last writer wins" — the returned DOCX replaces the database version. This fails when the spec writer has made changes to the database while the document was out for review (which always happens during active design).

A simpler approach is "require the document to be current before returning" — i.e., lock the spec during review. This is operationally impractical: reviews take weeks, and design progresses.

## Decision

Git-style 3-way merge:

- **Base version:** The spec state at the time of DOCX generation (tracked via `base_version` per paragraph)
- **Theirs:** The returned DOCX (Owner's changes)
- **Ours:** The current database state (spec writer's changes since generation)

The diff algorithm:
- **Change in theirs only:** Auto-apply (Owner changed, spec writer didn't → no conflict)
- **Change in ours only:** Already in database (spec writer's change won → no action needed)
- **Change in both theirs and ours:** Conflict — present to spec writer for resolution
- **Addition in theirs:** Present to spec writer to accept or reject
- **Deletion in theirs:** Present to spec writer to accept or reject

The spec writer reviews conflicts via `POST /specs/:id/diff` response, then submits accepted change UUIDs plus that `DiffResult` via `POST /specs/:id/merge`. They are never forced to take Owner changes, and Owner changes never silently overwrite spec writer work.

## Consequences

- Every paragraph must carry `base_version` — an integer incremented on each merge. This is a lightweight version vector, not full git object storage.
- `paragraph_versions` table stores text snapshots at each version, enabling the "base" side of the 3-way diff even after the database has moved on.
- The merge UI (Phase 5 web interface) must present conflicts clearly: base | theirs | ours side-by-side. The API (`/diff` response) must carry all three versions in the payload.
- We do not attempt to auto-merge within a paragraph (word-level diffing). If a paragraph was touched by both sides, it is a conflict. Word-level merging would require linguistic analysis and introduce false confidence.
- Track changes in the Owner's DOCX are not automatically processed. If the Owner used Word's track changes feature, they must accept/reject within Word before returning the file. This is documented as a workflow requirement, not a technical limitation to fix. (Superseded for Phase 3a by the bullet below — virtual acceptance replaced the hard requirement.)
- Phase 3a (issue #34) accepts track changes virtually: `w:ins` text is counted as present, `w:del` text as absent, every record is captured raw, and the diff emits a warning. Refusing track-changes documents or consuming the records directly (preserve as pending review) is deferred to a follow-up issue and an ADR-005 amendment.
- Phase 3c keeps merge state client-carried: `/merge` receives the `DiffResult` returned by `/diff` instead of reading a persisted pending-diff table. This avoids inventing server-side review sessions before the Phase 5 UI exists. A future UI may add pending-review persistence if auditability or collaboration requires it.
- **Single bump per merge call (#374):** `applyAccepted` runs every accepted entry — text changes, additions, deletions — inside one caller-owned transaction and `specs.content_version` is incremented at most once per `/merge` call, not once per applied entry. Both `insertSiblingRow` and `setVanishRow` are deliberately gate-free/bump-free DB cores for this reason; only the outer `applyMerge` service touches `content_version`, mirroring the same invariant the standalone insert/removal endpoints already hold for a single write.
- **Addition apply reuses the sibling-insert primitive:** an accepted `diff.added` entry is inserted via the same `insertSiblingRow` core behind `POST /specs/{id}/paragraphs` (#372), anchored on `afterUuid` — the nearest preceding controlled paragraph in document order — using the diff-synthesized `uuid` as an explicit id so a re-submitted/retried accept resolves to a no-op instead of a duplicate row.
- **Deletion apply reuses reversible removal:** an accepted `diff.deleted` entry sets `vanish = true` via the same `setVanishRow` core behind `PATCH .../removal` (#251, ADR-022) — never a hard delete — snapshotting the pre-toggle text into `paragraph_versions`. Only body paragraph types are removable this way; the same node-type allowlist governs both entry points.
- **KNOWN AMBIGUITY — anchorless addition unsupported:** a `diff.added` entry with no `afterUuid` (nothing controlled precedes it in document order — e.g. an Owner-inserted paragraph before the first `w:sdt`) has no anchor to insert after and is rejected (400) rather than guessed at. **Table-cell paragraphs are deliberately kept anchorless too** (see `extract.ts`): a `w:tbl` cell has no CSI tier, so even when a controlled paragraph precedes the table, anchoring its cells (and later flattening them into body siblings) would corrupt structure — they stay anchorless and hit this same rejection. The spec writer must incorporate such additions by hand; this is not a bug to silently work around.
- **KNOWN AMBIGUITY — structural-anchor additions rejected, not inserted:** a `diff.added` entry whose `afterUuid` resolves to a structural node (`part`/`article`/`note` — anything outside the pr1–pr7/continuation body tier) is rejected (`structural-anchor` → 400 at `/merge`) rather than inserted as that node's sibling. The orphan carries no tier information, so inserting it beside an article would silently mint a second article (structural corruption), and beside a part it has no valid sibling at all. Inserting the orphan as a *child* of the structural node is a different primitive and out of scope for #374; the spec writer incorporates it by hand.
- **KNOWN AMBIGUITY — structural deletes are rejected, not cascaded:** a `diff.deleted` entry targeting a `part`/`article`/`note` uuid is rejected (`not-removable` → 400 at `/merge`, matching the 422 the standalone `PATCH .../removal` gives the same underlying status) rather than cascading the vanish to its subtree. The owner-facing renderers do not honor `vanish` on structural or note nodes (see `paragraph-vanish.ts`), so silently cascading it would misrepresent what the output actually suppresses.
- **Delete/modify conflict is its own bucket, not a plain delete (#465):** the "missing from theirs → deleted" rule above only holds when ours never diverged from base. When theirs deletes a base paragraph *and* ours has been edited in the DB since the base snapshot, that is the git-style delete/modify conflict line 29 already named — `classifyBase` (`src/merge/diff.ts`) now checks ours before bucketing a theirs-absent row, and routes the divergent case into a new `DiffResult.deleteConflicts: DeleteConflictDiff[]` (`{ uuid, base, ours }`, no `theirs` key — there is nothing to carry once the paragraph is gone from theirs) instead of `deleted`. This was a genuine contract change, not a bugfix within the existing shape: `ModifiedDiff.theirs` is a required string, and an empty-string sentinel for "absent" would be indistinguishable from a real empty-paragraph edit and risk silently blanking the paragraph on accept. Accepting a `deleteConflicts` entry via `/merge` still applies through the same `setVanishRow` reversible-delete path as `diff.deleted` (discard the divergent `ours`, take the deletion); omitting the uuid keeps the writer's edit untouched. `applyDeletedChange` additionally re-locks the row and compares its current text against the diffed `ours` before writing the vanish, guarding against a THIRD divergence between diff-compute time and accept time — the same stale-diff shape (409, bare `MergeError`) `applyTextChange` already used for `modified`/`conflicts`. `DiffResultSchema` and the OpenAPI `DiffResult`/`DeleteConflictDiff` schemas carry the new bucket in lockstep with `computeDiff`.
