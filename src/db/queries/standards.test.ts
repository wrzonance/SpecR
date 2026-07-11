import { describe, it, expect } from 'vitest';
import {
  parseStandardCitation,
  buildStandardsRollup,
  STANDARD_ANCHOR_CAP,
  type StandardCitationRow,
  type StandardRegistryRow,
} from './standards.js';

describe('parseStandardCitation', () => {
  it('splits "ORG identifier" on the first whitespace and uppercases the org', () => {
    expect(parseStandardCitation('ASTM C150')).toEqual({ orgCode: 'ASTM', standardCode: 'C150' });
    expect(parseStandardCitation('NFPA 70')).toEqual({ orgCode: 'NFPA', standardCode: '70' });
  });

  it('preserves identifier case and trims surrounding whitespace', () => {
    expect(parseStandardCitation('  ASTM   A653/A653M  ')).toEqual({
      orgCode: 'ASTM',
      standardCode: 'A653/A653M',
    });
  });

  it('lowercase org token is normalized to uppercase so it keys deterministically', () => {
    expect(parseStandardCitation('astm c150')).toEqual({ orgCode: 'ASTM', standardCode: 'c150' });
  });

  // KNOWN AMBIGUITY: a cited string with no whitespace (e.g. a .SEC RID like
  // "ANSI/TIA-568.1") cannot be split into org + identifier by whitespace. It is
  // treated as org-only with an empty standard code — the registry cannot verify
  // such a citation until a client records a verdict against the exact key. DOCX,
  // the product fidelity path, always emits "ORG ident", so this only touches .SEC.
  it('KNOWN AMBIGUITY: no-whitespace citation becomes org-only with empty code', () => {
    expect(parseStandardCitation('ANSI/TIA-568.1')).toEqual({
      orgCode: 'ANSI/TIA-568.1',
      standardCode: '',
    });
  });
});

const scope = { type: 'library' as const, id: 'lib-1' };

function citation(
  standardCode: string,
  specId: string,
  section: string,
  paragraphId: string
): StandardCitationRow {
  return {
    standardCode,
    sourceSpecId: specId,
    sourceSpecSection: section,
    sourceParagraphId: paragraphId,
  };
}

function registry(
  overrides: Partial<StandardRegistryRow> & Pick<StandardRegistryRow, 'orgCode' | 'standardCode'>
): StandardRegistryRow {
  return {
    title: null,
    currentVersion: null,
    sourceUrl: null,
    status: 'unknown',
    lastVerifiedAt: null,
    notes: null,
    ...overrides,
  };
}

describe('buildStandardsRollup', () => {
  it('compiles distinct cited standards with citation counts and citing specs', () => {
    const rollup = buildStandardsRollup(
      scope,
      [
        citation('ASTM C150', 'spec-a', '03 30 00', 'p1'),
        citation('ASTM C150', 'spec-a', '03 30 00', 'p2'),
        citation('ASTM C150', 'spec-b', '03 31 00', 'p3'),
        citation('NFPA 70', 'spec-b', '03 31 00', 'p4'),
      ],
      []
    );
    expect(rollup.standards).toHaveLength(2);
    const astm = rollup.standards.find((s) => s.standardCode === 'C150');
    expect(astm?.orgCode).toBe('ASTM');
    expect(astm?.citationCount).toBe(3);
    expect(astm?.citingSpecs).toEqual([
      { specId: 'spec-a', section: '03 30 00' },
      { specId: 'spec-b', section: '03 31 00' },
    ]);
    expect(astm?.anchors).toEqual(['p1', 'p2', 'p3']);
    expect(astm?.registered).toBe(false);
    expect(astm?.status).toBe('unknown');
  });

  it('joins the registry verdict onto the matching cited standard', () => {
    const rollup = buildStandardsRollup(
      scope,
      [citation('ASTM C150', 'spec-a', '03 30 00', 'p1')],
      [
        registry({
          orgCode: 'ASTM',
          standardCode: 'C150',
          status: 'current',
          currentVersion: 'C150/C150M-22',
          sourceUrl: 'https://example.test/astm-c150',
          lastVerifiedAt: '2026-07-01T00:00:00.000Z',
        }),
      ]
    );
    const row = rollup.standards[0];
    expect(row?.registered).toBe(true);
    expect(row?.status).toBe('current');
    expect(row?.currentVersion).toBe('C150/C150M-22');
    expect(row?.sourceUrl).toBe('https://example.test/astm-c150');
    expect(row?.lastVerifiedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(rollup.summary.registered).toBe(1);
    expect(rollup.summary.unverified).toBe(0);
  });

  it('emits a finding for a cited standard the registry marks superseded or withdrawn', () => {
    const rollup = buildStandardsRollup(
      scope,
      [
        citation('ASTM C150', 'spec-a', '03 30 00', 'p1'),
        citation('NFPA 70', 'spec-b', '26 00 00', 'p2'),
      ],
      [
        registry({ orgCode: 'ASTM', standardCode: 'C150', status: 'superseded' }),
        registry({ orgCode: 'NFPA', standardCode: '70', status: 'withdrawn' }),
      ]
    );
    expect(rollup.findings).toHaveLength(2);
    const superseded = rollup.findings.find((f) => f.type === 'standard_superseded');
    expect(superseded?.orgCode).toBe('ASTM');
    expect(superseded?.citingSpecs).toEqual([{ specId: 'spec-a', section: '03 30 00' }]);
    expect(superseded?.anchors).toEqual(['p1']);
    const withdrawn = rollup.findings.find((f) => f.type === 'standard_withdrawn');
    expect(withdrawn?.standardCode).toBe('70');
    expect(rollup.summary.superseded).toBe(1);
    expect(rollup.summary.withdrawn).toBe(1);
    expect(rollup.summary.findings).toBe(2);
  });

  it('caps anchors per standard and flags truncation deterministically', () => {
    const many = Array.from({ length: STANDARD_ANCHOR_CAP + 5 }, (_, i) =>
      citation('ASTM C150', 'spec-a', '03 30 00', `p${String(i).padStart(3, '0')}`)
    );
    const rollup = buildStandardsRollup(scope, many, []);
    const row = rollup.standards[0];
    expect(row?.citationCount).toBe(STANDARD_ANCHOR_CAP + 5);
    expect(row?.anchors).toHaveLength(STANDARD_ANCHOR_CAP);
    expect(row?.anchorsTruncated).toBe(true);
    expect(row?.anchors[0]).toBe('p000');
  });

  it('sorts standards by org then code and counts unverified registrations', () => {
    const rollup = buildStandardsRollup(
      scope,
      [
        citation('NFPA 70', 'spec-b', '26 00 00', 'p2'),
        citation('ASTM C920', 'spec-a', '07 92 00', 'p3'),
        citation('ASTM C150', 'spec-a', '03 30 00', 'p1'),
      ],
      [registry({ orgCode: 'ASTM', standardCode: 'C150', status: 'current' })]
    );
    expect(rollup.standards.map((s) => `${s.orgCode} ${s.standardCode}`)).toEqual([
      'ASTM C150',
      'ASTM C920',
      'NFPA 70',
    ]);
    expect(rollup.summary.standards).toBe(3);
    expect(rollup.summary.registered).toBe(1);
    // unverified = cited standards with no lastVerifiedAt (unregistered, or registered
    // without a recorded verdict) — here all three, incl. the status-only ASTM C150.
    expect(rollup.summary.unverified).toBe(3);
  });
});
