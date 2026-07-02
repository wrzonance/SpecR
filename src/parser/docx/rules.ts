// ilvl → NodeType resolution for DOCX parsing.
//
// Format-agnostic cross-reference extraction (SECTION_REF_RULES, standards orgs)
// lives in src/parser/refs/.

import type { NodeType } from '../../ast/types.js';

// ─── ilvl → NodeType resolution ──────────────────────────────────────────────

const NODE_TYPE_SEQUENCE: readonly NodeType[] = [
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
];

/**
 * Map a raw OOXML ilvl to a canonical CSI NodeType.
 * articleIlvl comes from NumberingMap — detected from numbering.xml or overridden by the orchestrator via StyleMap.
 * Returns 'continuation' for ilvl values beyond the defined sequence.
 */
export function ilvlToNodeType(ilvl: number, articleIlvl: number): NodeType {
  if (ilvl === 0) return 'part';
  if (ilvl < articleIlvl) return 'continuation'; // reserved levels (e.g. Schedule, PDS)
  const offset = ilvl - articleIlvl;
  return NODE_TYPE_SEQUENCE[offset] ?? 'continuation';
}
