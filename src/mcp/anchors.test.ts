import { describe, it, expect } from 'vitest';
import {
  anchorsFromSearch,
  anchorsFromSpecTree,
  anchorsFromReferences,
  anchorsFromReport,
  anchorsMeta,
  ANCHORS_META_KEY,
} from './anchors.js';

describe('anchorsFromSearch', () => {
  it('maps each hit to {section, specId, paragraphId} and drops empty sections', () => {
    const anchors = anchorsFromSearch([
      {
        paragraphId: 'p1',
        text: 't',
        nodeType: 'pr1',
        specId: 's1',
        specSection: '07 84 00',
        specTitle: 'Firestopping',
      },
      {
        paragraphId: 'p2',
        text: 't',
        nodeType: 'pr1',
        specId: 's2',
        specSection: '',
        specTitle: '',
      },
    ]);
    expect(anchors).toEqual([{ section: '07 84 00', specId: 's1', paragraphId: 'p1' }]);
  });
});

describe('anchorsFromSpecTree', () => {
  it('yields one {section, specId} anchor', () => {
    expect(anchorsFromSpecTree({ id: 's1', section: '09 21 16' })).toEqual([
      { section: '09 21 16', specId: 's1' },
    ]);
  });
  it('yields nothing for a blank section', () => {
    expect(anchorsFromSpecTree({ id: 's1', section: '' })).toEqual([]);
  });
});

describe('anchorsFromReferences', () => {
  it('includes the queried section plus outbound/inbound anchors', () => {
    const anchors = anchorsFromReferences({
      section: '08 11 13',
      outbound: [
        {
          sourceSpecId: 's1',
          referenceText: 'x',
          targetSection: '07 84 00',
          targetSpecId: 't1',
          isResolved: true,
          isBroken: false,
        },
        {
          sourceSpecId: 's1',
          referenceText: 'y',
          targetSection: null,
          targetSpecId: null,
          isResolved: false,
          isBroken: true,
        },
      ],
      inbound: [
        {
          sourceSpecId: 's9',
          sourceSection: '09 21 16',
          sourceTitle: 'Gyp',
          sourceParagraphId: 'p9',
          referenceText: 'z',
          isResolved: true,
          isBroken: false,
        },
      ],
    });
    expect(anchors).toEqual([
      { section: '08 11 13' },
      { section: '07 84 00', specId: 't1' },
      { section: '09 21 16', specId: 's9', paragraphId: 'p9' },
    ]);
  });
});

describe('anchorsFromReport', () => {
  // dangling_ref carries an exact sourceParagraphId (from BrokenRef); the other
  // reference-consistency findings (e.g. related_cited_not_listed) are built from
  // ClassifiedRef, which has no per-paragraph locator, so they anchor at the
  // source section only. present_not_required / required_not_present anchor at
  // their own `section` field.
  it('locates dangling-ref findings at the source paragraph; other findings at their section', () => {
    const anchors = anchorsFromReport([
      {
        type: 'dangling_ref',
        refId: 'r1',
        sourceSpecId: 's1',
        sourceSpecSection: '08 11 13',
        sourceParagraphId: 'p1',
        snippet: 'see Section 07 84 00',
        targetSpecSection: '07 84 00',
        referenceText: 'Section 07 84 00',
        availableFrom: [],
      },
      {
        type: 'related_cited_not_listed',
        sourceSpecId: 's3',
        sourceSpecSection: '26 05 33',
        section: '26 05 33',
      },
      { type: 'present_not_required', section: '01 10 00', specId: 's2', title: 'Summary' },
      { type: 'required_not_present', section: '03 30 00', title: null, requiredId: 'r1' },
    ]);
    expect(anchors).toEqual([
      { section: '08 11 13', specId: 's1', paragraphId: 'p1' },
      { section: '26 05 33', specId: 's3' },
      { section: '01 10 00', specId: 's2' },
      { section: '03 30 00' },
    ]);
  });
});

describe('anchorsMeta', () => {
  it('wraps non-empty anchors under the namespaced key', () => {
    expect(anchorsMeta([{ section: '07 84 00' }])).toEqual({
      [ANCHORS_META_KEY]: [{ section: '07 84 00' }],
    });
  });
  it('is undefined for an empty list (so no _meta is attached)', () => {
    expect(anchorsMeta([])).toBeUndefined();
  });
});
