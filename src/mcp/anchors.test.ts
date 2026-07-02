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

  it('anchors submittal, implied, and umbrella findings at their source (specId key varies)', () => {
    const anchors = anchorsFromReport([
      {
        type: 'product_without_submittal_type',
        specId: 's4',
        sourceSpecSection: '23 05 00',
        productName: 'Pump',
        sourceParagraphId: 'p4',
      },
      {
        type: 'submittal_type_without_product',
        specId: 's5',
        sourceSpecSection: '23 07 00',
        submittalType: 'Product Data',
      },
      {
        type: 'implied_related_section',
        sourceSpecId: 's6',
        sourceSpecSection: '07 92 00',
        sourceParagraphId: 'p6',
        impliedSection: '07 84 00',
        impliedTitle: 'Firestopping',
        matchedKeyword: 'firestop',
        confidence: 0.8,
      },
      {
        type: 'umbrella_not_called_out',
        sourceSpecId: 's7',
        sourceSpecSection: '09 21 16',
        umbrellaSpecSection: '09 20 00',
      },
    ]);
    expect(anchors).toEqual([
      { section: '23 05 00', specId: 's4', paragraphId: 'p4' },
      { section: '23 07 00', specId: 's5' },
      { section: '07 92 00', specId: 's6', paragraphId: 'p6' },
      { section: '09 21 16', specId: 's7' },
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
