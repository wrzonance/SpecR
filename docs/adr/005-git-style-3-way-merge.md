# ADR-005: Git-Style 3-Way Merge for Owner Redlines

## Status: In progress — Phase 3a (extract + diff algorithm)

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

The spec writer reviews conflicts via `POST /specs/:id/diff` response, then submits accepted change UUIDs via `POST /specs/:id/merge`. They are never forced to take Owner changes, and Owner changes never silently overwrite spec writer work.

## Consequences

- Every paragraph must carry `base_version` — an integer incremented on each merge. This is a lightweight version vector, not full git object storage.
- `paragraph_versions` table stores text snapshots at each version, enabling the "base" side of the 3-way diff even after the database has moved on.
- The merge UI (Phase 5 web interface) must present conflicts clearly: base | theirs | ours side-by-side. The API (`/diff` response) must carry all three versions in the payload.
- We do not attempt to auto-merge within a paragraph (word-level diffing). If a paragraph was touched by both sides, it is a conflict. Word-level merging would require linguistic analysis and introduce false confidence.
- Track changes in the Owner's DOCX are not automatically processed. If the Owner used Word's track changes feature, they must accept/reject within Word before returning the file. This is documented as a workflow requirement, not a technical limitation to fix. (Superseded for Phase 3a by the bullet below — virtual acceptance replaced the hard requirement.)
- Phase 3a (issue #34) accepts track changes virtually: `w:ins` text is counted as present, `w:del` text as absent, every record is captured raw, and the diff emits a warning. Refusing track-changes documents or consuming the records directly (preserve as pending review) is deferred to a follow-up issue and an ADR-005 amendment.
