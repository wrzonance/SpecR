import { describe, it, expect } from 'vitest';
import {
  isRelsUnreadableDetail,
  buildRelsUnreadableWarnings,
} from './header-footer-media-warnings.js';
import { RELS_UNREADABLE_REASON } from './header-footer-media-parts.js';
import type { HeaderFooterUnmodeledEntry } from './types.js';

// #502 (issue acceptance: "One part-level capture warning") — every entry
// below mirrors a real producer's exact `detail` shape: header-footer-
// images.ts's relsUnreadableEntry (carries rId), header-footer-table.ts's
// imageUnmodeledEntry (no rId, table-cell drawings never parse a descriptor),
// and header-footer.ts's three PRE-EXISTING unresolvedReference producers
// (missingPartEntry/duplicateReferenceEntry key on `target`+`rId`+`reason`;
// unresolvedToUnmodeled keys on `rId` alone) — none of which ever set `part`.

function relsUnreadableEntry(
  part: string,
  rId?: string,
  region: 'header' | 'footer' = 'header',
  variant: 'default' | 'first' | 'even' = 'default'
): HeaderFooterUnmodeledEntry {
  return {
    variant,
    region,
    kind: 'unresolvedReference',
    detail:
      rId !== undefined
        ? { rId, part, reason: RELS_UNREADABLE_REASON }
        : { part, reason: RELS_UNREADABLE_REASON },
  };
}

function missingPartEntry(target: string, rId: string): HeaderFooterUnmodeledEntry {
  return {
    variant: 'default',
    region: 'header',
    kind: 'unresolvedReference',
    detail: { target, rId, reason: 'relationship target has no matching header/footer part' },
  };
}

function unresolvedToUnmodeledEntry(rId: string): HeaderFooterUnmodeledEntry {
  return { variant: 'default', region: 'header', kind: 'unresolvedReference', detail: { rId } };
}

function duplicateReferenceEntry(target: string, rId: string): HeaderFooterUnmodeledEntry {
  return {
    variant: 'default',
    region: 'header',
    kind: 'unresolvedReference',
    detail: {
      target,
      rId,
      reason:
        'duplicate header/footer reference for this variant/region — only the first ' +
        'resolved target is captured',
    },
  };
}

describe('isRelsUnreadableDetail', () => {
  it('matches a #502 relsUnreadable detail carrying rId (header-footer-images.ts shape)', () => {
    expect(
      isRelsUnreadableDetail({
        rId: 'rId1',
        part: 'word/header1.xml',
        reason: RELS_UNREADABLE_REASON,
      })
    ).toBe(true);
  });

  it('matches a #502 relsUnreadable detail with no rId (header-footer-table.ts shape)', () => {
    expect(
      isRelsUnreadableDetail({ part: 'word/header1.xml', reason: RELS_UNREADABLE_REASON })
    ).toBe(true);
  });

  // Non-interference (task 3 requirement): the three PRE-EXISTING
  // unresolvedReference producers in header-footer.ts key on `target`, never
  // `part` — none should ever be mistaken for a #502 relsUnreadable entry.
  it("REGRESSION: does not match missingPartEntry's detail shape (keys on target, not part)", () => {
    expect(isRelsUnreadableDetail(missingPartEntry('header9.xml', 'rId1').detail)).toBe(false);
  });

  it("REGRESSION: does not match unresolvedToUnmodeled's detail shape (rId only)", () => {
    expect(isRelsUnreadableDetail(unresolvedToUnmodeledEntry('rId1').detail)).toBe(false);
  });

  it("REGRESSION: does not match duplicateReferenceEntry's detail shape (keys on target, not part)", () => {
    expect(isRelsUnreadableDetail(duplicateReferenceEntry('header1.xml', 'rId2').detail)).toBe(
      false
    );
  });

  it('rejects non-object and null detail values without throwing', () => {
    expect(isRelsUnreadableDetail(undefined)).toBe(false);
    expect(isRelsUnreadableDetail(null)).toBe(false);
    expect(isRelsUnreadableDetail('word/header1.xml')).toBe(false);
    expect(isRelsUnreadableDetail(42)).toBe(false);
  });

  it('rejects an object whose part field is not a string', () => {
    expect(isRelsUnreadableDetail({ part: 123 })).toBe(false);
  });
});

describe('buildRelsUnreadableWarnings', () => {
  // INV-8: a damaged part with zero qualifying drawings emits no warning —
  // an empty unmodeled list, or one containing only pre-existing
  // unresolvedReference shapes, must never fabricate a line.
  it('INV-8: emits no warnings when unmodeled is empty', () => {
    expect(buildRelsUnreadableWarnings([])).toEqual([]);
  });

  it('INV-8: emits no warnings when unmodeled contains only pre-existing unresolvedReference shapes', () => {
    const unmodeled = [
      missingPartEntry('header9.xml', 'rId1'),
      unresolvedToUnmodeledEntry('rId2'),
      duplicateReferenceEntry('header1.xml', 'rId3'),
    ];
    expect(buildRelsUnreadableWarnings(unmodeled)).toEqual([]);
  });

  it('emits exactly one aggregate line for a single damaged part with one qualifying drawing', () => {
    const unmodeled = [relsUnreadableEntry('word/header1.xml', 'rId1')];
    expect(buildRelsUnreadableWarnings(unmodeled)).toEqual([
      "word/header1.xml's relationships index is unreadable; 1 image reference(s) could not be resolved",
    ]);
  });

  // INV-5: the SAME damaged part referenced by multiple variant slots
  // (default + first + even) dedupes into exactly ONE line, with a count
  // summing every qualifying entry across all of them — never one line per
  // drawing, never one line per variant.
  it('INV-5: dedupes the same damaged part across multiple variant/region slots into one line with a summed count', () => {
    const unmodeled = [
      relsUnreadableEntry('word/header1.xml', 'rId1', 'header', 'default'),
      relsUnreadableEntry('word/header1.xml', 'rId2', 'header', 'first'),
      relsUnreadableEntry('word/header1.xml', undefined, 'header', 'even'),
    ];
    expect(buildRelsUnreadableWarnings(unmodeled)).toEqual([
      "word/header1.xml's relationships index is unreadable; 3 image reference(s) could not be resolved",
    ]);
  });

  it('emits one line per distinct damaged part, never merging two different parts together', () => {
    const unmodeled = [
      relsUnreadableEntry('word/header1.xml', 'rId1'),
      relsUnreadableEntry('word/footer1.xml', 'rId2'),
      relsUnreadableEntry('word/footer1.xml', 'rId3', 'footer', 'first'),
    ];
    expect(buildRelsUnreadableWarnings(unmodeled)).toEqual([
      "word/header1.xml's relationships index is unreadable; 1 image reference(s) could not be resolved",
      "word/footer1.xml's relationships index is unreadable; 2 image reference(s) could not be resolved",
    ]);
  });

  it('non-interference: a mix of #502 and pre-existing unresolvedReference entries only aggregates the #502 ones', () => {
    const unmodeled = [
      missingPartEntry('header9.xml', 'rId1'),
      relsUnreadableEntry('word/header1.xml', 'rId2'),
      unresolvedToUnmodeledEntry('rId3'),
      relsUnreadableEntry('word/header1.xml', 'rId4'),
      duplicateReferenceEntry('header1.xml', 'rId5'),
    ];
    expect(buildRelsUnreadableWarnings(unmodeled)).toEqual([
      "word/header1.xml's relationships index is unreadable; 2 image reference(s) could not be resolved",
    ]);
  });
});
