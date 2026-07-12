import { describe, it, expect } from 'vitest';
import { computeDiff } from './diff.js';
import type { ExtractResult, TrackChangeRecord } from './types.js';
import type { ParagraphSnapshot } from '../ast/types.js';

const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';

function snap(uuid: string, text: string, baseVersion = 1): ParagraphSnapshot {
  return { uuid, text, baseVersion };
}

function extract(
  controlled: readonly (readonly [string, string])[],
  orphans: readonly { text: string; index: number; afterUuid?: string | undefined }[] = [],
  records: readonly TrackChangeRecord[] = []
): ExtractResult {
  return {
    controlled: new Map(controlled),
    orphans: orphans.map((o) => ({ text: o.text, index: o.index, afterUuid: o.afterUuid })),
    trackChanges: { present: records.length > 0, records },
  };
}

describe('computeDiff', () => {
  it('theirs-only change → modified entry with ours === base, no conflict', () => {
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'base text')],
      extract([[U1, 'owner edit']])
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
      extract([[U1, 'base text']])
    );
    expect(result.modified).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('both sides changed → conflict carrying full base/theirs/ours', () => {
    const result = computeDiff(
      [snap(U1, 'base text')],
      [snap(U1, 'writer edit')],
      extract([[U1, 'owner edit']])
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
      extract([[U1, 'base text']])
    );
    expect(result).toEqual({ added: [], modified: [], deleted: [], conflicts: [], warnings: [] });
  });

  it('UUID in base but missing from theirs → deleted', () => {
    const result = computeDiff(
      [snap(U1, 'kept'), snap(U2, 'removed by owner')],
      [snap(U1, 'kept'), snap(U2, 'removed by owner')],
      extract([[U1, 'kept']])
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
    const result = computeDiff([snap(U1, 'base text')], [snap(U1, 'writer edit')], extract([]));
    expect(result.deleted).toEqual([U1]);
    expect(result.conflicts).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('paragraph absent from ours falls back to base text → theirs change is modified, not conflict', () => {
    const result = computeDiff([snap(U1, 'base text')], [], extract([[U1, 'owner edit']]));
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
      { uuidGen: () => `fixed-${n++}` }
    );
    expect(result.added.map((a) => a.uuid)).toEqual(['fixed-0', 'fixed-1']);
  });

  it('defaults to crypto.randomUUID when no uuidGen injected', () => {
    const result = computeDiff([], [], extract([], [{ text: 'a', index: 0 }]));
    expect(result.added[0]?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('empty inputs → empty DiffResult', () => {
    const result = computeDiff([], [], extract([]));
    expect(result).toEqual({ added: [], modified: [], deleted: [], conflicts: [], warnings: [] });
  });

  it('track-change records present → single warning naming the record count', () => {
    const records: TrackChangeRecord[] = [
      { kind: 'ins', uuid: U1, text: 'added', author: 'OwnerA', date: '2026-05-20T10:00:00Z' },
      { kind: 'del', uuid: U1, text: 'removed', author: 'OwnerA', date: '2026-05-20T10:00:00Z' },
    ];
    const result = computeDiff(
      [snap(U1, 'base')],
      [snap(U1, 'base')],
      extract([[U1, 'base']], [], records)
    );
    expect(result.warnings).toEqual([
      'document contained 2 track-change records — diff treats them as accepted',
    ]);
  });

  it('no track changes → no warnings', () => {
    const result = computeDiff([], [], extract([]));
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
      ])
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
      ])
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
      )
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
});
