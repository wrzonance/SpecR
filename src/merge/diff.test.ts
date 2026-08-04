import { describe, it, expect } from 'vitest';
import { computeDiff } from './diff.js';
import { fingerprintBlob } from './object-fingerprint.js';
import type { ExtractedObjectBlock, ExtractResult, TrackChangeRecord } from './types.js';
import type { ParagraphSnapshot } from '../ast/types.js';
import type { ObjectBlobNode, ObjectMeta } from '../ast/index.js';
import type { ObjectStructuralSnapshot } from '../db/index.js';

const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';
const OBJ1 = '00000000-0000-0000-0000-0000000000a1';

function snap(uuid: string, text: string, baseVersion = 1): ParagraphSnapshot {
  return { uuid, text, baseVersion };
}

function extract(
  controlled: readonly (readonly [string, string])[],
  orphans: readonly { text: string; index: number; afterUuid?: string | undefined }[] = [],
  records: readonly TrackChangeRecord[] = [],
  objectBlocks: readonly ExtractedObjectBlock[] = []
): ExtractResult {
  return {
    controlled: new Map(controlled),
    orphans: orphans.map((o) => ({ text: o.text, index: o.index, afterUuid: o.afterUuid })),
    trackChanges: { present: records.length > 0, records },
    objectBlocks,
  };
}

/** Hand-built fast-xml-parser preserveOrder-shaped table blob, N rows x
 *  cells[i].length — mirrors object-fingerprint.test.ts's tableBlob, so a
 *  base ObjectMeta and theirs' ExtractedObjectBlock fingerprint from the same
 *  canonical shape (#520). */
function tableBlob(rowTexts: readonly (readonly string[])[]): ObjectBlobNode[] {
  const columnCount = rowTexts[0]?.length ?? 0;
  return [
    {
      'w:tbl': [
        { 'w:tblGrid': Array.from({ length: columnCount }, () => ({ 'w:gridCol': [] })) },
        ...rowTexts.map((cells) => ({
          'w:tr': cells.map((text) => ({
            'w:tc': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] }],
          })),
        })),
      ],
    },
  ];
}

function tableSnapshot(
  objectId: string,
  rowTexts: readonly (readonly string[])[],
  childUuids: readonly string[]
): ObjectStructuralSnapshot {
  const meta: ObjectMeta = {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    blob: tableBlob(rowTexts),
  };
  return { objectId, meta, childUuids };
}

function tableBlock(
  rowTexts: readonly (readonly string[])[],
  interiorUuids: readonly string[]
): ExtractedObjectBlock {
  return { interiorUuids, fingerprint: fingerprintBlob(tableBlob(rowTexts)) };
}

describe('computeDiff', () => {
  it('theirs-only change → modified entry with ours === base, no conflict', () => {
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'base text')],
      extract([[U1, 'owner edit']]),
      []
    );
    expect(result.modified).toEqual([
      { uuid: U1, base: 'base text', theirs: 'owner edit', ours: 'base text' },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('ours-only change → no diff entry (change already in DB)', () => {
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'writer edit')],
      extract([[U1, 'base text']]),
      []
    );
    expect(result.modified).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('both sides changed → conflict carrying full base/theirs/ours', () => {
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'writer edit')],
      extract([[U1, 'owner edit']]),
      []
    );
    expect(result.conflicts).toEqual([
      { uuid: U1, base: 'base text', theirs: 'owner edit', ours: 'writer edit' },
    ]);
    expect(result.modified).toEqual([]);
  });

  it('both sides unchanged → empty DiffResult', () => {
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'base text')],
      extract([[U1, 'base text']]),
      []
    );
    expect(result).toEqual({
      added: [],
      modified: [],
      deleted: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
  });

  it('UUID in base but missing from theirs → deleted', () => {
    const result = computeDiff(
      [snap(U1, 'kept'), snap(U2, 'removed by owner')],
      [snap(U1, 'kept'), snap(U2, 'removed by owner')],
      extract([[U1, 'kept']]),
      []
    );
    expect(result.deleted).toEqual([U2]);
    expect(result.modified).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('theirs-deletes a paragraph ours edited since base → classified as a plain delete', () => {
    // KNOWN AMBIGUITY (#465): classifyBase checks "missing from theirs → deleted"
    // BEFORE consulting ours, so an owner delete of a paragraph the spec writer
    // edited in the DB since base (ours "writer edit" ≠ base "base text") is emitted
    // as a plain delete, not the git-style delete/modify conflict ADR-005 line 29
    // implies. Accepting it (since #374) vanishes the writer's edit — reversibly
    // (setVanishRow + paragraph_versions snapshot), but without surfacing the
    // divergence. Pinned here as current behavior; the fix (a delete/modify-conflict
    // category + apply-time guard) is a /diff contract change tracked in #465.
    const result = computeDiff([snap(U1, 'base text')], [snap(U1, 'writer edit')], extract([]), []);
    expect(result.deleted).toEqual([U1]);
    expect(result.conflicts).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('paragraph absent from ours falls back to base text → theirs change is modified, not conflict', () => {
    const result = computeDiff([snap(U1, 'base text')], [], extract([[U1, 'owner edit']]), []);
    expect(result.modified).toEqual([
      { uuid: U1, base: 'base text', theirs: 'owner edit', ours: 'base text' },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it('orphan paragraph in theirs → added with synthesized uuid, document index, and afterUuid', () => {
    const result = computeDiff(
      [snap(U1, 'kept')],
      [snap(U1, 'kept')],
      extract([[U1, 'kept']], [{ text: 'new owner paragraph', index: 3, afterUuid: U1 }]),
      [],
      { uuidGen: () => 'fixed-0' }
    );
    expect(result.added).toEqual([
      { uuid: 'fixed-0', text: 'new owner paragraph', index: 3, afterUuid: U1 },
    ]);
  });

  it('two orphans sharing one anchor uuid → both added entries carry the same afterUuid', () => {
    let n = 0;
    const result = computeDiff(
      [snap(U1, 'kept')],
      [snap(U1, 'kept')],
      extract(
        [[U1, 'kept']],
        [
          { text: 'first new', index: 1, afterUuid: U1 },
          { text: 'second new', index: 2, afterUuid: U1 },
        ]
      ),
      [],
      { uuidGen: () => `fixed-${n++}` }
    );
    expect(result.added).toEqual([
      { uuid: 'fixed-0', text: 'first new', index: 1, afterUuid: U1 },
      { uuid: 'fixed-1', text: 'second new', index: 2, afterUuid: U1 },
    ]);
  });

  it('injected uuidGen makes added uuids deterministic across orphans', () => {
    let n = 0;
    const result = computeDiff(
      [],
      [],
      extract(
        [],
        [
          { text: 'first', index: 0 },
          { text: 'second', index: 1 },
        ]
      ),
      [],
      { uuidGen: () => `fixed-${n++}` }
    );
    expect(result.added.map((a) => a.uuid)).toEqual(['fixed-0', 'fixed-1']);
  });

  it('defaults to crypto.randomUUID when no uuidGen injected', () => {
    const result = computeDiff([], [], extract([], [{ text: 'a', index: 0 }]), []);
    expect(result.added[0]?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('empty inputs → empty DiffResult', () => {
    const result = computeDiff([], [], extract([]), []);
    expect(result).toEqual({
      added: [],
      modified: [],
      deleted: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
  });

  it('track-change records present → single warning naming the record count', () => {
    const records: TrackChangeRecord[] = [
      { kind: 'ins', uuid: U1, text: 'added', author: 'OwnerA', date: '2026-05-20T10:00:00Z' },
      { kind: 'del', uuid: U1, text: 'removed', author: 'OwnerA', date: '2026-05-20T10:00:00Z' },
    ];
    const result = computeDiff(
      [snap(U1, 'base')],
      [snap(U1, 'base')],
      extract([[U1, 'base']], [], records),
      []
    );
    expect(result.warnings).toEqual([
      'document contained 2 track-change records — diff treats them as accepted',
    ]);
  });

  it('no track changes → no warnings', () => {
    const result = computeDiff([], [], extract([]), []);
    expect(result.warnings).toEqual([]);
  });

  it('unknown controlled UUID in theirs → warning with count, buckets empty', () => {
    // U1 is known (in base), U2 is unknown (not in base) — U2 must surface as a warning
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'base text')],
      extract([
        [U1, 'base text'],
        [U2, 'surprise text'],
      ]),
      []
    );
    expect(result.warnings).toEqual([
      '1 controlled paragraph(s) in the returned DOCX carry unknown UUIDs and were ignored',
    ]);
    expect(result.modified).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('all controlled UUIDs known → no unknown-uuid warning', () => {
    const result = computeDiff(
      [snap(U1, 'base text'), snap(U2, 'other')],
      [snap(U1, 'base text'), snap(U2, 'other')],
      extract([
        [U1, 'base text'],
        [U2, 'other'],
      ]),
      []
    );
    expect(result.warnings).toEqual([]);
  });

  it('unknown-uuid warning appears before track-changes warning when both present', () => {
    const records: TrackChangeRecord[] = [
      { kind: 'ins', uuid: U1, text: 'added', author: 'OwnerA', date: '2026-05-20T10:00:00Z' },
    ];
    const result = computeDiff(
      [snap(U1, 'base')],
      [snap(U1, 'base')],
      extract(
        [
          [U1, 'base'],
          [U2, 'surprise'],
        ],
        [],
        records
      ),
      []
    );
    expect(result.warnings).toEqual([
      '1 controlled paragraph(s) in the returned DOCX carry unknown UUIDs and were ignored',
      'document contained 1 track-change record — diff treats it as accepted',
    ]);
  });

  it('combined: theirs-edited paragraph + orphan → modified and added, no leakage between buckets', () => {
    let n = 0;
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'base text')],
      extract([[U1, 'owner edit']], [{ text: 'new paragraph', index: 5 }]),
      [],
      { uuidGen: () => `fixed-${n++}` }
    );
    expect(result.modified).toEqual([
      { uuid: U1, base: 'base text', theirs: 'owner edit', ours: 'base text' },
    ]);
    expect(result.added).toEqual([
      { uuid: 'fixed-0', text: 'new paragraph', index: 5, afterUuid: undefined },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  describe('object structural conflicts (#520)', () => {
    it("an object row's own uuid never appears in modified/deleted/conflicts, even though theirs carries no anchor for it", () => {
      // The table itself is never w:sdt-anchored in the DOCX — only its interior
      // paragraphs are — so without exclusion OBJ1 would read as an ordinary delete.
      const snapshot = tableSnapshot(OBJ1, [['A1', 'B1']], []);
      const result = computeDiff([snap(OBJ1, '')], [snap(OBJ1, '')], extract([]), [snapshot]);
      expect(result.deleted).toEqual([]);
      expect(result.modified).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.objectConflicts).toEqual([]);
    });

    it('diverging table structure (base 1 row vs theirs 2 rows) → one objectConflicts entry, affectedUuids excluded from every other bucket', () => {
      const baseSnapshot = tableSnapshot(OBJ1, [['A1', 'B1']], [U1, U2]);
      const theirsBlock = tableBlock(
        [
          ['A1', 'B1'],
          ['A2', 'B2'],
        ],
        [U1, U2]
      );
      const result = computeDiff(
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        // U1's text changed and U2 is entirely absent from theirs.controlled — both
        // would otherwise register as modified/deleted if not excluded below.
        extract([[U1, 'owner changed cell one']], [], [], [theirsBlock]),
        [baseSnapshot]
      );
      expect(result.objectConflicts).toEqual([
        {
          objectId: OBJ1,
          affectedUuids: [U1, U2],
          base: fingerprintBlob(baseSnapshot.meta.blob),
          theirs: theirsBlock.fingerprint,
        },
      ]);
      expect(result.modified).toEqual([]);
      expect(result.deleted).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it('matching structure between base and theirs → no objectConflicts entry, per-cell text diff still applies normally', () => {
      const rowTexts = [['A1', 'B1']];
      const baseSnapshot = tableSnapshot(OBJ1, rowTexts, [U1, U2]);
      const theirsBlock = tableBlock(rowTexts, [U1, U2]);
      const result = computeDiff(
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        extract(
          [
            [U1, 'cell one'],
            [U2, 'owner edited cell'],
          ],
          [],
          [],
          [theirsBlock]
        ),
        [baseSnapshot]
      );
      expect(result.objectConflicts).toEqual([]);
      expect(result.modified).toEqual([
        { uuid: U2, base: 'cell two', theirs: 'owner edited cell', ours: 'cell two' },
      ]);
      expect(result.deleted).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it('merge: whole-object delete — all interior anchors gone from theirs', () => {
      // #525: the editor deleted the WHOLE table in Word, so none of its interior
      // anchors survive anywhere in theirs.controlled (not just outside a matched
      // block) — this must emit one atomic objectConflicts entry (theirs absent),
      // NOT per-child deletes, or the generator re-emits the deleted blob verbatim
      // on the next round-trip while the diff misleadingly reports interior deletes.
      const baseSnapshot = tableSnapshot(OBJ1, [['A1', 'B1']], [U1, U2]);
      const result = computeDiff(
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        extract([]), // no object blocks and no controlled uuids at all in theirs
        [baseSnapshot]
      );
      expect(result.objectConflicts).toEqual([
        { objectId: OBJ1, affectedUuids: [U1, U2], base: fingerprintBlob(baseSnapshot.meta.blob) },
      ]);
      expect(result.objectConflicts[0]).not.toHaveProperty('theirs');
      expect(result.deleted).toEqual([]);
      expect(result.modified).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it('partial interior deletion (some but not all anchored children removed) keeps the #520 structural-diverge path, not a whole-object signal', () => {
      // AC boundary: only U2 is removed from the table's interior anchors while the
      // table block itself survives (still matched by findMatchingBlock via U1) —
      // this must stay the EXISTING #520 diverging-fingerprint path (theirs present),
      // never get reclassified as a #525 whole-object delete.
      const baseSnapshot = tableSnapshot(OBJ1, [['A1', 'B1']], [U1, U2]);
      const theirsBlock = tableBlock([['A1']], [U1]); // U2's cell is gone → 1 column, not 2
      const result = computeDiff(
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        extract([[U1, 'cell one']], [], [], [theirsBlock]),
        [baseSnapshot]
      );
      expect(result.objectConflicts).toEqual([
        {
          objectId: OBJ1,
          affectedUuids: [U1, U2],
          base: fingerprintBlob(baseSnapshot.meta.blob),
          theirs: theirsBlock.fingerprint,
        },
      ]);
      expect(result.deleted).toEqual([]);
      expect(result.modified).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it('KNOWN AMBIGUITY: object block gone, but one interior anchor survives outside it — falls through to ordinary per-child diffing, not a whole-object signal', () => {
      // #525 explicitly does not resolve this sub-case: the table block itself is
      // entirely absent from theirs.objectBlocks (findMatchingBlock === undefined,
      // as in a clean whole-object delete), yet U1 still exists in theirs.controlled
      // as a stray paragraph outside any object block — e.g. Word left one cell's
      // text behind as a loose paragraph while the table markup itself vanished.
      // isWholeObjectDeletion correctly refuses to call this a clean whole-object
      // delete (not ALL children are absent), so it falls through to ordinary
      // per-child classification: U1 diffs normally (modified), U2 (genuinely gone)
      // reads as an ordinary delete. This is a real ambiguity — the source doesn't
      // decidably say whether the editor meant "delete the table" or "delete the
      // table but keep this one cell's text as a paragraph" — so it is pinned as
      // current behavior here rather than silently picked, per CLAUDE.md.
      const baseSnapshot = tableSnapshot(OBJ1, [['A1', 'B1']], [U1, U2]);
      const result = computeDiff(
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        [snap(OBJ1, ''), snap(U1, 'cell one'), snap(U2, 'cell two')],
        extract([[U1, 'surviving stray text']]), // no objectBlocks; U1 survives as a stray controlled paragraph
        [baseSnapshot]
      );
      expect(result.objectConflicts).toEqual([]);
      expect(result.modified).toEqual([
        { uuid: U1, base: 'cell one', theirs: 'surviving stray text', ours: 'cell one' },
      ]);
      expect(result.deleted).toEqual([U2]);
      expect(result.conflicts).toEqual([]);
    });

    it('childless object snapshot → no objectConflicts signal from either #520 or #525 paths', () => {
      // childUuids: [] is the pre-existing always-childless case (an object with no
      // w:sdt-anchored interior paragraphs at all) — isWholeObjectDeletion's
      // childUuids.length > 0 guard must keep this a no-op, same as before #525.
      const snapshot = tableSnapshot(OBJ1, [['A1', 'B1']], []);
      const result = computeDiff([snap(OBJ1, '')], [snap(OBJ1, '')], extract([]), [snapshot]);
      expect(result.objectConflicts).toEqual([]);
      expect(result.deleted).toEqual([]);
      expect(result.modified).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });
  });
});
