// Format-agnostic extraction rules: CSI section refs + standards-org refs.
// Operates on any text content reachable through SpecTree walks.
// Rules are data — not code — so agents can inspect, propose, and fix them.

// ─── Rule type ────────────────────────────────────────────────────────────────

export interface ExtractionRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly targetType: 'section' | 'standard';
  readonly examples: readonly string[];
  readonly knownFalsePositives?: readonly string[];
}

// ─── CSI section refs ─────────────────────────────────────────────────────────

export const SECTION_REF_RULES: readonly ExtractionRule[] = [
  {
    id: 'csi-section-keyword',
    description:
      'Matches "Section XX XX XX" — standard CSI cross-reference with keyword prefix. ' +
      'Most reliable pattern; matches how spec writers are trained to cite other sections.',
    pattern: /\bSection\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/gi,
    targetType: 'section',
    examples: ['See Section 09 91 00', 'Section 27 21 00 applies to this work'],
    knownFalsePositives: [],
  },
];

// ─── Standards-org refs ───────────────────────────────────────────────────────

export interface StandardOrgPattern {
  readonly orgCode: string; // 'ASTM', 'NFPA', etc.
  readonly displayName: string;
  readonly identifierPattern: string; // regex fragment after orgCode
}

// 11 orgs in scope for Phase 1c-iii (per design doc).
// Phase 5 UI will migrate this to a standard_orgs DB table populated via CRUD endpoint.
// buildStandardRefRules is the seam — signature unchanged regardless of source.
export const STANDARD_ORG_PATTERNS: readonly StandardOrgPattern[] = [
  {
    orgCode: 'ASTM',
    displayName: 'ASTM International',
    identifierPattern: '[A-Z]?\\d+(?:[\\-./]\\d+[A-Za-z]?)?',
  },
  {
    orgCode: 'ANSI',
    displayName: 'American National Standards Institute',
    identifierPattern: '[A-Z]?\\d+(?:\\.\\d+)?(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'IEEE',
    displayName: 'Institute of Electrical & Electronics Eng.',
    identifierPattern: '\\d+(?:\\.\\d+)?(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'NFPA',
    displayName: 'National Fire Protection Association',
    identifierPattern: '\\d+[A-Z]?(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'UL',
    displayName: 'Underwriters Laboratories',
    identifierPattern: '\\d+[A-Z]?(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'NEMA',
    displayName: 'National Electrical Manufacturers Assoc.',
    identifierPattern: '[A-Z]+[\\-\\s]?\\d+(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'NEC',
    displayName: 'National Electrical Code',
    identifierPattern: '\\d+(?:[\\-.]\\d+)?',
  },
  {
    orgCode: 'TIA',
    displayName: 'Telecommunications Industry Association',
    identifierPattern: '\\d+[\\-./]?[A-Z]?(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'BICSI',
    displayName: 'Building Industry Consulting Service Intl.',
    identifierPattern: '\\d+(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'ASME',
    displayName: 'American Society of Mechanical Engineers',
    identifierPattern: '[A-Z]?\\d+(?:\\.\\d+)?(?:[\\-./]\\d+)?',
  },
  {
    orgCode: 'ASHRAE',
    displayName: 'ASHRAE',
    identifierPattern: '\\d+(?:[\\-./]\\d+)?',
  },
];

export function buildStandardRefRules(
  orgs: readonly StandardOrgPattern[]
): readonly ExtractionRule[] {
  return orgs.map((o) => ({
    id: `standard-${o.orgCode.toLowerCase()}`,
    description: `Matches "${o.orgCode} <identifier>" — ${o.displayName} standards.`,
    pattern: new RegExp(`\\b(${o.orgCode})\\s+(${o.identifierPattern})\\b`, 'g'),
    targetType: 'standard' as const,
    examples: [`${o.orgCode} 100`],
  }));
}
