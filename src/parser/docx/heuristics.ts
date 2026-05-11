import type { NodeType } from '../../ast/types.js';

interface TextSignalEntry {
  readonly pattern: RegExp;
  readonly nodeType: NodeType;
  readonly normalizedIlvl: number;
}

// All patterns anchored to ^ — prevents mid-word matches (e.g. "3i)" in product codes).
// Ordered most-specific first.
const TEXT_SIGNALS: readonly TextSignalEntry[] = [
  { pattern: /^PART\s+\d+/i, nodeType: 'part', normalizedIlvl: 0 },
  { pattern: /^\d+\.\d+\s+/, nodeType: 'article', normalizedIlvl: 1 },
  { pattern: /^[A-Z]\.\s/, nodeType: 'pr1', normalizedIlvl: 2 },
  { pattern: /^\d+\.\s/, nodeType: 'pr2', normalizedIlvl: 3 },
  { pattern: /^[a-z]\.\s/, nodeType: 'pr3', normalizedIlvl: 4 },
  { pattern: /^\d+\)\s/, nodeType: 'pr4', normalizedIlvl: 5 },
  { pattern: /^[a-z]\)\s/, nodeType: 'pr5', normalizedIlvl: 6 },
];

const MIN_TEXT_LENGTH = 4;
const TWIPS_PER_LEVEL = 576;
const MAX_ILVL = 8;

/**
 * Signal 4: Text regex heuristics.
 * Detects CSI hierarchical patterns from paragraph text.
 *
 * @param text - Paragraph text to match
 * @returns { nodeType, normalizedIlvl } if matched, null otherwise
 */
export function matchTextSignal(
  text: string
): { readonly nodeType: NodeType; readonly normalizedIlvl: number } | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;

  for (const entry of TEXT_SIGNALS) {
    if (entry.pattern.test(trimmed)) {
      return { nodeType: entry.nodeType, normalizedIlvl: entry.normalizedIlvl };
    }
  }

  return null;
}

/**
 * Signal 5: Indentation heuristic.
 * Converts twips left indent to normalized ilvl estimate.
 * Assumes constant 576 twip per-level step.
 *
 * @param leftIndent - Paragraph leftIndent in twips, or undefined
 * @returns Estimated ilvl (0-8), or null if invalid
 */
export function matchIndentSignal(leftIndent: number | undefined): number | null {
  if (leftIndent === undefined) return null;

  const estimated = Math.round(leftIndent / TWIPS_PER_LEVEL);
  if (estimated < 0 || estimated > MAX_ILVL) return null;

  return estimated;
}
