import type { ObjectStructureFingerprint } from './object-fingerprint.js';

// Re-exported for merge consumers' convenience; canonical definition is src/ast/types.ts
export type { ParagraphSnapshot } from '../ast/types.js';

export interface TrackChangeRecord {
  readonly kind: 'ins' | 'del';
  readonly uuid?: string | undefined; // enclosing w:sdt tag if present
  readonly text: string;
  readonly author?: string | undefined;
  readonly date?: string | undefined; // w:date attr, ISO
}

/**
 * One body-level object (a `w:tbl` table or a `w:drawing`/`w:pict` text box,
 * #520) discovered during extraction: the specr-uuid anchors of its interior
 * paragraphs (document order, possibly empty for an unanchored object) plus
 * its text-blind structural fingerprint, for structural-conflict detection
 * during 3-way merge.
 */
export interface ExtractedObjectBlock {
  readonly interiorUuids: readonly string[];
  readonly fingerprint: ObjectStructureFingerprint;
}

export interface ExtractResult {
  /** uuid → plain text (post virtual-accept of track changes) */
  readonly controlled: ReadonlyMap<string, string>;
  /** non-empty paragraphs outside any specr-uuid w:sdt, with document-order index */
  readonly orphans: readonly {
    readonly text: string;
    readonly index: number;
    /** nearest preceding controlled uuid in document order, undefined if none */
    readonly afterUuid: string | undefined;
  }[];
  readonly trackChanges: {
    readonly present: boolean;
    readonly records: readonly TrackChangeRecord[];
  };
  /** body-level tables and text boxes, in document order (#520) */
  readonly objectBlocks: readonly ExtractedObjectBlock[];
}

export interface ParagraphDiff {
  /** synthesized via uuidGen at diff time */
  readonly uuid: string;
  readonly text: string;
  /** document order in theirs */
  readonly index: number;
  /** nearest preceding controlled uuid in document order; the key is optional so
   *  the Zod merge-request parse shape (afterUuid an optional key) is directly
   *  assignable to this internal shape — no reconciling mapper needed. */
  readonly afterUuid?: string | undefined;
}

export interface ModifiedDiff {
  readonly uuid: string;
  readonly base: string;
  readonly theirs: string;
  readonly ours: string;
}

/** Same shape as ModifiedDiff; presence in conflicts[] signals the kind. */
export type ConflictDiff = ModifiedDiff;

/**
 * One base-paragraph that theirs deleted while ours diverged from base since
 * the snapshot was taken (#465) — the git-style delete/modify conflict
 * ADR-005 line 29 names but classifyBase previously folded into a plain
 * `deleted` entry, silently discarding the writer's edit on accept.
 *
 * Deliberately has NO `theirs` key — not an empty-string sentinel, an
 * outright omission — because theirs is ALWAYS absent for this bucket: the
 * paragraph is gone from the returned DOCX, so there is no theirs text to
 * carry. Reusing ModifiedDiff (whose `theirs` is a required string) was
 * rejected: representing "absent" as `theirs: ''` is indistinguishable from
 * a real empty-string edit and risks a blank-on-accept bug if a future
 * writer forgets to special-case it.
 */
export interface DeleteConflictDiff {
  readonly uuid: string;
  readonly base: string;
  readonly ours: string;
}

/**
 * One atomic structural conflict on a body-level object: either a structural
 * divergence (#520) or a whole-object deletion (#525). `affectedUuids` (the
 * object's base-side interior child anchors) are excluded from
 * modified/deleted/conflicts above for the same paragraphs either way.
 *
 * - `theirs` PRESENT — #520 structural-diverge case: a `theirs` block was
 *   matched (shares ≥1 interior child uuid with `affectedUuids`) but its
 *   fingerprint diverges from `base` (row/column added or removed, a
 *   textBox/table kind change, etc).
 * - `theirs` ABSENT — #525 whole-object-delete case: every one of the
 *   object's interior child anchors is absent from the returned DOCX; there
 *   is no `theirs` block to fingerprint because the object itself is gone.
 *   See docs/adr/089-whole-object-delete-detection.md.
 */
export interface ObjectConflictDiff {
  readonly objectId: string;
  readonly affectedUuids: readonly string[];
  readonly base: ObjectStructureFingerprint;
  readonly theirs?: ObjectStructureFingerprint;
}

export interface DiffResult {
  readonly added: readonly ParagraphDiff[];
  readonly modified: readonly ModifiedDiff[];
  /** uuids present in base but absent from theirs */
  readonly deleted: readonly string[];
  /**
   * uuids present in base and absent from theirs (same "missing from theirs"
   * branch as `deleted` above — these are siblings), but where ours also
   * diverged from base since the snapshot was taken (#465): a delete/modify
   * conflict, not a clean delete.
   */
  readonly deleteConflicts: readonly DeleteConflictDiff[];
  readonly conflicts: readonly ConflictDiff[];
  /** atomic structural conflicts on body-level objects (#520) */
  readonly objectConflicts: readonly ObjectConflictDiff[];
  readonly warnings: readonly string[];
}

export type UuidGen = () => string;
