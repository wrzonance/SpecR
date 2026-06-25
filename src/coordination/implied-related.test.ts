import { describe, expect, it } from 'vitest';
import { buildTitleKeywordIndex, findImpliedRelatedSections } from './index.js';

describe('implied related-section title keyword matching', () => {
  it('coordination: conduit body mentions firestopping but 07 84 00 not listed -> implied_related_section', () => {
    const index = buildTitleKeywordIndex([
      { section: '07 84 00', title: 'Firestopping' },
      { section: '26 05 33', title: 'Raceways and Boxes for Electrical Systems' },
    ]);

    const findings = findImpliedRelatedSections({
      catalog: index,
      specs: [
        {
          specId: 'spec-conduit',
          section: '26 05 33',
          relatedSections: [],
          bodyCitedSections: [],
          paragraphs: [
            {
              id: 'para-firestop',
              text: 'Firestopping shall be provided where conduits penetrate rated assemblies.',
            },
          ],
        },
      ],
    });

    expect(findings).toEqual([
      {
        type: 'implied_related_section',
        sourceSpecId: 'spec-conduit',
        sourceSpecSection: '26 05 33',
        sourceParagraphId: 'para-firestop',
        impliedSection: '07 84 00',
        impliedTitle: 'Firestopping',
        matchedKeyword: 'firestop',
        confidence: 0.72,
      },
    ]);
  });

  it('coordination: already listed implied section yields no implied_related_section', () => {
    const index = buildTitleKeywordIndex([{ section: '07 84 00', title: 'Firestopping' }]);

    const findings = findImpliedRelatedSections({
      catalog: index,
      specs: [
        {
          specId: 'spec-conduit',
          section: '26 05 33',
          relatedSections: ['07 84 00'],
          bodyCitedSections: [],
          paragraphs: [{ id: 'para-firestop', text: 'Provide firestopping at penetrations.' }],
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it('coordination: explicitly cited body section suppresses implied_related_section', () => {
    const index = buildTitleKeywordIndex([{ section: '07 84 00', title: 'Firestopping' }]);

    const findings = findImpliedRelatedSections({
      catalog: index,
      specs: [
        {
          specId: 'spec-conduit',
          section: '26 05 33',
          relatedSections: [],
          bodyCitedSections: ['07 84 00'],
          paragraphs: [{ id: 'para-firestop', text: 'Section 07 84 00 Firestopping' }],
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it('coordination: generic title words such as general do not imply related sections', () => {
    const index = buildTitleKeywordIndex([
      { section: '01 00 00', title: 'General Requirements' },
      { section: '01 10 00', title: 'Summary of Work' },
      { section: '07 84 00', title: 'Firestopping' },
    ]);

    const findings = findImpliedRelatedSections({
      catalog: index,
      specs: [
        {
          specId: 'spec-doors',
          section: '08 11 13',
          relatedSections: [],
          bodyCitedSections: [],
          paragraphs: [{ id: 'para-general', text: 'Provide the work in general conformance.' }],
        },
      ],
    });

    expect(findings).toEqual([]);
  });
});
