# ADR-090: whole-object-delete detection reuses ObjectConflictDiff with an optional `theirs`

## Status

Accepted

## Context

ADR-072 §21 (#520) gave the 3-way merge engine atomic structural-conflict
detection for body-level objects (tables/text boxes): `detectObjectConflicts`
pairs a base-side `ObjectStructuralSnapshot` to the matching `theirs`
`ExtractedObjectBlock` BY SHARED INTERIOR CHILD UUID (`findMatchingBlock`),
because — per decision 3 — an object carries no `w:sdt` anchor of its own in
the DOCX; only its interior paragraphs are anchored. §21 explicitly scoped
object add/delete/move *lifecycle* OUT as a KNOWN AMBIGUITY (ADR-072 §20's
sibling gap, decisions #5/#7 of #520): there is no reliable base↔theirs
identity for the object row itself without either anchoring it directly or a
positional/ordinal heuristic that is itself ambiguous under reorder.

#525 found the resulting gap has a silent-corruption consequence, not just a
missing feature. When an editor deletes an **entire** object in Word — every
one of its interior anchors disappears from `theirs`, not just some —
`findMatchingBlock` returns `undefined`, so no `ObjectConflictDiff` is
emitted. The object's own row is unconditionally excluded from
`classifyBase` (`buildExcludedUuids` always excludes every
`ObjectStructuralSnapshot.objectId`, independent of whether a conflict was
detected — ADR-072 §21), so the blob row is never touched. Its interior
`objectText` anchors then fall through to `classifyBase`'s ordinary "missing
from theirs → deleted" rule and surface as per-child paragraph deletions.
Accepting those deletions removes the interior anchors, but the generator
(`src/generator/object-block.ts`) re-emits the object's captured
`object_data.blob` verbatim regardless of anchor state — the table/text box
**reappears** in the next generated DOCX. The editor's whole-object delete is
silently discarded while the diff misleadingly reports it as several
ordinary paragraph deletes.

## Decision

### Direction 2 (detect-and-emit-atomic-conflict), not direction 1 (`w:sdt`-anchor the object row)

The issue itself named two directions and asked for direction 1 to be
treated as a stop-and-report blocker unless direction 2 provably cannot
satisfy the acceptance criteria. It does not: every signal
`isWholeObjectDeletion` needs (`ObjectStructuralSnapshot.childUuids`,
`theirs.controlled`) already exists from #520. `w:sdt`-anchoring the object
row itself would give true cross-side object identity (enabling delete *and*
move detection, and eventually materializing the delete), but it is a
generator+parser cross-cutting change with its own full-corpus round-trip
revalidation burden, is a different PR's worth of scope under this repo's
~500-LOC cap, and buys nothing this issue's acceptance criteria require. It
remains available as a follow-up if object move/reorder detection is ever
prioritized.

### Detection signal: check `theirs.controlled` membership directly, not `findMatchingBlock(...) === undefined`

```ts
function isWholeObjectDeletion(
  childUuids: readonly string[],
  theirsControlled: ReadonlyMap<string, string>
): boolean {
  return childUuids.length > 0 && childUuids.every((uuid) => !theirsControlled.has(uuid));
}
```

The coarser trigger `findMatchingBlock(...) === undefined && childUuids.length > 0`
was considered and rejected: it also fires when a single interior child
survives as a stray paragraph *outside* any object block while the object
block itself vanished (e.g. Word leaves one cell's text behind as a loose
paragraph). Treating that as a clean whole-object delete would silently
exclude the survivor from ordinary per-paragraph diffing — the wrong answer,
and a second silent-data-loss bug of exactly the shape this ADR exists to
close. Checking `theirs.controlled` membership directly distinguishes the
two cases: whole-object delete needs **every** child gone from `theirs`
*entirely*, not merely gone from a matched block. The partial-escape case is
pinned as an explicit `// KNOWN AMBIGUITY` test
(`src/merge/diff.test.ts`, `'KNOWN AMBIGUITY: object block gone, but one
interior anchor survives outside it'`) rather than silently resolved either
way, per this repo's OOXML-ambiguity convention.

### Representation: `ObjectConflictDiff.theirs` becomes an optional key, not a new type

```ts
export interface ObjectConflictDiff {
  readonly objectId: string;
  readonly affectedUuids: readonly string[];
  readonly base: ObjectStructureFingerprint;
  /** Present: #520 structural-diverge. Absent: #525 whole-object-delete —
   *  there is no theirs block to fingerprint because the object is gone. */
  readonly theirs?: ObjectStructureFingerprint;
}
```

A parallel type (e.g. `ObjectRemovedDiff` plus a `DiffResult.removedObjects`
field and a new `ApplicableChange` variant) was considered and rejected.
Every existing consumer of `ObjectConflictDiff` —
`buildExcludedUuids`/`detectObjectConflicts` (`src/merge/diff.ts`),
`objectConflictEntries`/`applicableChanges`/`validateAccepted`
(`src/merge/conflict.ts`), and the Zod dedup `superRefine` pass
(`src/ast/merge-schemas.ts`) — only ever reads `.objectId` and
`.affectedUuids`; none branches on `.theirs`. A whole-object delete *is* the
same decision as a structural-diverge object-conflict for every consumer
that matters: atomic, detection-only, reject-on-accept, exclude children
from ordinary buckets. Introducing a second type to express an identical
behavioral contract would mean touching every one of those integration
points twice for no behavioral difference — the DRY-without-over-abstraction
bar this repo's `code.md` states explicitly. The optional-key move also
mirrors a precedent ADR-072 §21 already established in this exact file for
`ObjectStructureFingerprint.rows`/`.columns` under
`exactOptionalPropertyTypes: true` — `.exactOptional()` on the Zod schema
(`src/ast/merge-schemas.ts`), not `.optional()`, so the parsed shape stays
directly assignable to the TS interface with no adapter.

Confirmed empirically before relying on it: `tsc --noEmit` passes with zero
changes required in `src/api/merge.ts` or `src/mcp/merge-handlers.ts` after
this change — both are pure pass-through of the parsed `DiffResult`, unlike
the two-step schema-then-consumer failure ADR-072 §21 documented for #520's
own `objectConflicts` field addition. This time there was no downstream
breakage to fix.

### Apply path: unchanged, reuses `'object-conflict'` verbatim

`conflict.ts`'s `objectConflictEntries`/`applicableChanges`/`validateAccepted`
needed **zero** changes: they already resolve every `ObjectConflictDiff`
entry's `objectId` + every `affectedUuids` member to the existing
`'object-conflict'` `ApplicableChange` kind and reject accepting any of them
before any write, with the same message
(`... resolve the table/text box by hand`), regardless of whether `theirs`
is present. A more specific rejection message distinguishing "this object
was entirely removed" from "this object's structure changed" is UX polish,
not required by any acceptance criterion here, and is deferred — a reviewer
can request it explicitly. Actually materializing an accepted whole-object
delete (hard/soft-deleting the object row and its children together) stays
out of scope, matching the existing object-conflict's detection-only,
resolve-by-hand posture from ADR-072 §21.

## Consequences

- Whole-object deletion in a returned DOCX now surfaces as one atomic
  `objectConflicts` entry (`theirs` absent) instead of silently discarding
  the delete while misreporting per-child paragraph deletes — closing the
  blob-survives/anchors-vanish inconsistency #525 identified.
  `src/merge/conflict.integration.test.ts`'s `'applyAccepted —
  whole-object-delete conflict rejection (#525)'` suite pins that accepting
  either the object id or any affected child is rejected before any write,
  including when other accepted uuids in the same call are otherwise valid.
- Partial interior deletion (some but not all anchored children removed)
  is unchanged: it still matches a `theirs` block via `findMatchingBlock`
  and takes the pre-existing #520 structural-diverge path (`theirs`
  present). Pinned by `src/merge/diff.test.ts`'s `'partial interior
  deletion (some but not all anchored children removed) keeps the #520
  structural-diverge path'` boundary test.
- The partial-escape sub-case (object block gone, one interior child
  survives as a stray paragraph outside any object block) remains a KNOWN
  AMBIGUITY, unresolved by design — see the detection-signal rationale
  above. It is not blocked on further design work; it is pinned as current
  behavior.
- `openapi.yaml`'s `ObjectConflictDiff.required` drops `theirs`; its
  description and `DiffResult.objectConflicts`'s now document both the
  #520 and #525 cases the same field set covers.
- If object add/move/reorder detection is ever prioritized, direction 1
  (`w:sdt`-anchoring the object row itself) remains the documented path —
  this ADR does not foreclose it, it only establishes that #525's narrower
  delete-detection problem does not need it.
- Corpus non-regression: this change touches only `src/merge/` and
  `src/ast/merge-schemas.ts` (plus `openapi.yaml`), none of which the
  parser/generator pipeline `fixtureRecord` exercises — `pnpm
  fixture:snapshot`/`pnpm fixture:diff` confirms 0 changed, addition-only,
  matching the same reasoning ADR-072 §21 already established for #520.
