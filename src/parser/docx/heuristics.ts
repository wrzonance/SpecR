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

// PART heading pattern — shared with Signal 1 guard in inference.ts.
// LibreOffice exports <ol><li> items with numId > 0 at ilvl=0 (same level as PART headings).
// Without this guard, Signal 1 misclassifies them as 'part'.
const PART_HEADING_PATTERN = /^PART\s+\d+/i;

/**
 * Returns true if the text looks like a CSI PART heading (e.g. "PART 1 – GENERAL").
 * Used by Signal 1 as a confirmation guard when ilvl=0, preventing generic numbered
 * lists exported by LibreOffice/Word from being misclassified as PART nodes.
 */
export function isPartHeading(text: string): boolean {
  return PART_HEADING_PATTERN.test(text.trim());
}

// Specifier-note banners vary by vendor: "** NOTE TO SPECIFIER **" (ARCAT),
// "SPECIFIER NOTES:", "NOTES TO SPEC WRITER", with arbitrary decoration
// (asterisks, dashes, brackets, hashes) around the phrase. Strip decoration
// and collapse whitespace, then match the phrase variants at the start.
//
// These two patterns are mirrored verbatim into the 'Industry Default' editing
// convention seed (migration 024, ADR-022 D3) so banner detection can move from
// this hardcoded path to the data-driven classifier (O-6) with no behavior
// change. Keep the two copies in sync until the classifier supersedes this.
const NOTE_TO_SPECIFIER_PATTERN = /^NOTES? TO (?:THE )?SPEC(?:IFIER|S| WRITER)?S?\b/;
const SPECIFIER_NOTES_PATTERN = /^SPEC(?:IFIER)?S? NOTES?\b/;

/**
 * Returns true if the text opens with a specifier-note banner in any of its
 * vendor variants, ignoring leading decoration characters.
 */
export function isSpecifierNote(text: string): boolean {
  const undecorated = text
    .trim()
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
  return NOTE_TO_SPECIFIER_PATTERN.test(undecorated) || SPECIFIER_NOTES_PATTERN.test(undecorated);
}

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
