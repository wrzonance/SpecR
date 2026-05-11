// Extraction rules and ilvl signal maps as typed data constants.
// Plain-language descriptions make these surfaceable to LLMs via MCP tools.
// Rules are data — not code — so agents can inspect, propose, and fix them.

import type { NodeType } from '../../ast/types.js';

// ─── Cross-reference extraction rules ────────────────────────────────────────

export interface ExtractionRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly targetType: 'section' | 'standard';
  readonly examples: readonly string[];
  readonly knownFalsePositives?: readonly string[];
}

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

// ─── ilvl → NodeType signal maps ─────────────────────────────────────────────
// Used for MCP surfacing: agents can read these to understand how ilvl values
// map to canonical CSI node types for each numbering convention.

export interface IlvlSignalRule {
  readonly id: string;
  readonly description: string;
  readonly ilvl: number;
  readonly nodeType: NodeType;
}

// ARCAT machine-generated specs: Article at ilvl 1.
export const ARCAT_ILVL_MAP: readonly IlvlSignalRule[] = [
  {
    id: 'arcat-part',
    ilvl: 0,
    nodeType: 'part',
    description: 'ARCAT Part heading (ilvl 0 → PART N GENERAL)',
  },
  {
    id: 'arcat-article',
    ilvl: 1,
    nodeType: 'article',
    description: 'ARCAT Article heading (ilvl 1 → N.N HEADING)',
  },
  {
    id: 'arcat-pr1',
    ilvl: 2,
    nodeType: 'pr1',
    description: 'ARCAT PR1 first paragraph tier (ilvl 2 → A. text)',
  },
  {
    id: 'arcat-pr2',
    ilvl: 3,
    nodeType: 'pr2',
    description: 'ARCAT PR2 second paragraph tier (ilvl 3 → 1. text)',
  },
  {
    id: 'arcat-pr3',
    ilvl: 4,
    nodeType: 'pr3',
    description: 'ARCAT PR3 third paragraph tier (ilvl 4 → a. text)',
  },
  {
    id: 'arcat-pr4',
    ilvl: 5,
    nodeType: 'pr4',
    description: 'ARCAT PR4 fourth paragraph tier (ilvl 5 → 1) text)',
  },
  {
    id: 'arcat-pr5',
    ilvl: 6,
    nodeType: 'pr5',
    description: 'ARCAT PR5 fifth paragraph tier (ilvl 6 → a) text)',
  },
];

// CPI (Chatsworth Products Inc.) manufacturer specs: ilvl 1-2 reserved for Schedule/PDS.
// Article appears at ilvl 3, shifting all content tiers up by 2 vs ARCAT.
export const CPI_ILVL_MAP: readonly IlvlSignalRule[] = [
  {
    id: 'cpi-part',
    ilvl: 0,
    nodeType: 'part',
    description: 'CPI Part heading (ilvl 0 → PART N - GENERAL)',
  },
  {
    id: 'cpi-article',
    ilvl: 3,
    nodeType: 'article',
    description: 'CPI Article — ilvl 3 because ilvl 1-2 are reserved for Schedule/PDS',
  },
  {
    id: 'cpi-pr1',
    ilvl: 4,
    nodeType: 'pr1',
    description: 'CPI PR1 first paragraph tier (ilvl 4 → A. text)',
  },
  {
    id: 'cpi-pr2',
    ilvl: 5,
    nodeType: 'pr2',
    description: 'CPI PR2 second paragraph tier (ilvl 5 → 1. text)',
  },
  {
    id: 'cpi-pr3',
    ilvl: 6,
    nodeType: 'pr3',
    description: 'CPI PR3 third paragraph tier (ilvl 6 → a. text)',
  },
  {
    id: 'cpi-pr4',
    ilvl: 7,
    nodeType: 'pr4',
    description: 'CPI PR4 fourth paragraph tier (ilvl 7 → 1) text)',
  },
  {
    id: 'cpi-pr5',
    ilvl: 8,
    nodeType: 'pr5',
    description: 'CPI PR5 fifth paragraph tier (ilvl 8 → a) text)',
  },
];

// ─── ilvl → NodeType resolution ──────────────────────────────────────────────

const NODE_TYPE_SEQUENCE: readonly NodeType[] = ['article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5'];

/**
 * Map a raw OOXML ilvl to a canonical CSI NodeType.
 * articleIlvl is detected from numbering.xml (1 for ARCAT-style, 3 for CPI-style).
 * Returns 'continuation' for ilvl values beyond the defined sequence.
 */
export function ilvlToNodeType(ilvl: number, articleIlvl: number): NodeType {
  if (ilvl === 0) return 'part';
  if (ilvl < articleIlvl) return 'continuation'; // reserved levels (e.g. Schedule, PDS)
  const offset = ilvl - articleIlvl;
  return NODE_TYPE_SEQUENCE[offset] ?? 'continuation';
}
