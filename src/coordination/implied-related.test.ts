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

  it('coordination: parking-gate control board body does NOT imply 26 09 33 lighting control system (single polysemous keyword)', () => {
    const index = buildTitleKeywordIndex([
      { section: '26 09 33', title: 'ARCHITECTURAL LIGHTING CONTROL SYSTEM' },
    ]);

    const findings = findImpliedRelatedSections({
      catalog: index,
      specs: [
        {
          specId: 'spec-gate',
          section: '11 12 33',
          relatedSections: [],
          bodyCitedSections: [],
          paragraphs: [
            {
              id: 'para-gate',
              text: 'Operators for Overhead Gates: DoorKing Vehicular Overhead Gate Operator; Microprocessor based solid-state control board; duty cycle of 60 cycles per hour; adjustable automatic timer; heavy duty trolley assembly',
            },
          ],
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it('coordination: body naming BOTH lighting and control DOES imply 26 09 33 (two-keyword match)', () => {
    const index = buildTitleKeywordIndex([
      { section: '26 09 33', title: 'ARCHITECTURAL LIGHTING CONTROL SYSTEM' },
    ]);

    const findings = findImpliedRelatedSections({
      catalog: index,
      specs: [
        {
          specId: 'spec-lighting',
          section: '11 12 33',
          relatedSections: [],
          bodyCitedSections: [],
          paragraphs: [
            {
              id: 'para-lighting',
              text: 'Coordinate the lighting control zones with the low-voltage dimming panel.',
            },
          ],
        },
      ],
    });

    expect(findings).toEqual([
      {
        type: 'implied_related_section',
        sourceSpecId: 'spec-lighting',
        sourceSpecSection: '11 12 33',
        sourceParagraphId: 'para-lighting',
        impliedSection: '26 09 33',
        impliedTitle: 'ARCHITECTURAL LIGHTING CONTROL SYSTEM',
        matchedKeyword: 'control',
        confidence: 0.8,
      },
    ]);
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
