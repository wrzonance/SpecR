import { describe, expect, it } from 'vitest';
import {
  buildGeneralRequirementDuplication,
  type GeneralRequirementArticle,
  type GeneralRequirementScopeSpec,
} from './general-requirements.js';

function article(
  specId: string,
  section: string,
  paragraphId: string,
  title: string,
  partNumber = 1
): GeneralRequirementArticle {
  return { specId, section, paragraphId, title, partNumber };
}

const TECHNICAL: GeneralRequirementScopeSpec = {
  specId: 'technical',
  section: '26 05 33',
};

describe('buildGeneralRequirementDuplication', () => {
  it('matches recognized article-role variants and returns both paragraph locators', () => {
    const scope = [
      TECHNICAL,
      { specId: 'div01', section: '01 00 00' },
      { specId: 'umbrella', section: '26 00 00' },
    ];
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'technical-article', 'DELIVERY, STORAGE, AND HANDLING'),
      article('div01', '01 00 00', 'authority-article', 'DELIVERY STORAGE AND HANDLING'),
    ]);

    expect(result.findings).toEqual([
      {
        type: 'general_requirement_duplicated',
        sourceSpecId: 'technical',
        sourceSpecSection: '26 05 33',
        sourceParagraphId: 'technical-article',
        sourceArticleTitle: 'DELIVERY, STORAGE, AND HANDLING',
        authoritySpecId: 'div01',
        authoritySpecSection: '01 00 00',
        authorityParagraphId: 'authority-article',
        authorityArticleTitle: 'DELIVERY STORAGE AND HANDLING',
        authorityKind: 'division_00_01',
        matchBasis: 'article_role',
        matchedValue: 'delivery-storage-handling',
      },
    ]);
  });

  it('matches unclassified headings only at the exact normalized-title boundary', () => {
    const scope = [TECHNICAL, { specId: 'div01', section: '01 00 00' }];
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'technical-article', '1.8  MOCKUP COORDINATION'),
      article('div01', '01 00 00', 'authority-article', 'MOCKUP COORDINATION'),
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      matchBasis: 'normalized_title',
      matchedValue: 'MOCKUP COORDINATION',
    });
  });

  it('does not equate a broader technical addition with a general heading', () => {
    const scope = [TECHNICAL, { specId: 'div01', section: '01 00 00' }];
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'technical-article', 'SYSTEM-SPECIFIC MOCKUP COORDINATION'),
      article('div01', '01 00 00', 'authority-article', 'MOCKUP COORDINATION'),
    ]);

    expect(result.findings).toEqual([]);
  });

  it('excludes pointer-only References and Related Sections roles', () => {
    const scope = [TECHNICAL, { specId: 'div01', section: '01 00 00' }];
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'technical-ref', 'REFERENCES'),
      article('div01', '01 00 00', 'authority-ref', 'REFERENCE STANDARDS'),
      article('technical', '26 05 33', 'technical-related', 'RELATED REQUIREMENTS'),
      article('div01', '01 00 00', 'authority-related', 'RELATED SECTIONS'),
    ]);

    expect(result.findings).toEqual([]);
  });

  it('compares only PART 1 articles in technical sections', () => {
    const scope = [TECHNICAL, { specId: 'div01', section: '01 00 00' }];
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'part-two', 'QUALITY ASSURANCE', 2),
      article('div01', '01 00 00', 'authority', 'QUALITY ASSURANCE'),
    ]);

    expect(result.findings).toEqual([]);
  });

  it('uses only the technical section division umbrella as an authority', () => {
    const scope = [
      TECHNICAL,
      { specId: 'div01', section: '01 00 00' },
      { specId: 'umbrella26', section: '26 00 00' },
      { specId: 'umbrella27', section: '27 00 00' },
    ];
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'technical-article', 'QUALITY ASSURANCE'),
      article('umbrella26', '26 00 00', 'authority26', 'QUALITY ASSURANCE'),
      article('umbrella27', '27 00 00', 'authority27', 'QUALITY ASSURANCE'),
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      authoritySpecId: 'umbrella26',
      authorityKind: 'division_umbrella',
    });
  });

  it('deduplicates repeated authority rows and orders multiple matches deterministically', () => {
    const scope = [
      TECHNICAL,
      { specId: 'div01b', section: '01 20 00' },
      { specId: 'div01a', section: '01 10 00' },
    ];
    const duplicate = article('div01a', '01 10 00', 'authority-a', 'QUALITY ASSURANCE');
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'technical-article', 'QUALITY ASSURANCE'),
      article('div01b', '01 20 00', 'authority-b', 'QUALITY ASSURANCE'),
      duplicate,
      duplicate,
    ]);

    expect(result.findings.map((finding) => finding.authoritySpecSection)).toEqual([
      '01 10 00',
      '01 20 00',
    ]);
  });

  it('notes absent Division 00/01 and umbrella comparisons while checking available authorities', () => {
    const scope = [TECHNICAL, { specId: 'umbrella', section: '26 00 00' }];
    const result = buildGeneralRequirementDuplication(scope, [
      article('technical', '26 05 33', 'technical-article', 'QUALITY ASSURANCE'),
      article('umbrella', '26 00 00', 'authority', 'QUALITY ASSURANCE'),
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.notes).toEqual([
      'general-requirement duplicate check skipped Division 00/01 comparison: no Division 00/01 specs in scope',
    ]);

    const missingAll = buildGeneralRequirementDuplication(
      [TECHNICAL],
      [article('technical', '26 05 33', 'technical-article', 'QUALITY ASSURANCE')]
    );
    expect(missingAll.findings).toEqual([]);
    expect(missingAll.notes).toEqual([
      'general-requirement duplicate check skipped Division 00/01 comparison: no Division 00/01 specs in scope',
      'general-requirement duplicate check skipped umbrella comparison for absent sections: 26 00 00',
    ]);
  });
});
