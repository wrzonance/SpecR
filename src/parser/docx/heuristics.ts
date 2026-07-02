import type { NodeType } from '../../ast/types.js';

interface TextSignalEntry {
  readonly pattern: RegExp;
  readonly nodeType: NodeType;
  readonly normalizedIlvl: number;
}

// All patterns anchored to ^ — prevents mid-word matches (e.g. "3i)" in product codes).
// Ordered most-specific first. This ordering is load-bearing: the "N.0 <canonical
// part name>" PART pattern and the deeper N.N.N patterns MUST precede the generic
// "N.N" article pattern, because more-specific decimals match it too (first-match wins).
const TEXT_SIGNALS: readonly TextSignalEntry[] = [
  { pattern: /^PART\s+\d+/i, nodeType: 'part', normalizedIlvl: 0 },
  // PART headings authored in whole-number decimal form ("2.0 PRODUCTS",
  // "3.0 EXECUTION"): some manufacturer specs number PARTs as "N.0" and leave them
  // unstyled/unnumbered, so ONLY the text signal sees them. Gate on a canonical CSI
  // part name — a bare "N.0" alone is not enough evidence to outrank the article
  // pattern (a mis-numbered article or a "2.0 inches" measurement must stay put).
  {
    pattern: /^\d+\.0+[\s.:—–-]+(?:GENERAL|PRODUCTS|EXECUTION)\b/i,
    nodeType: 'part',
    normalizedIlvl: 0,
  },
  // Manual decimal outline (docs typed without Word numbering): depth = interior-dot
  // count (article = 1 dot, pr1 = 2, … pr7 = 8). The ladder is COMPLETE up to the
  // engine's deepest tier (pr7 / MAX_ILVL) so no realistic depth silently falls through
  // to a continuation — matching planOutlineNumberStrip, which strips a decimal prefix
  // of any depth. Deeper patterns MUST precede the N.N article pattern (first-match),
  // most dots first. "1.1.1.1" would never match the shorter N.N pattern (a "." follows
  // N.N, not whitespace), but ordering deepest-first keeps the intent explicit and safe.
  { pattern: /^\d+(?:\.\d+){8}\s+/, nodeType: 'pr7', normalizedIlvl: 8 }, // 8 dots
  { pattern: /^\d+(?:\.\d+){7}\s+/, nodeType: 'pr6', normalizedIlvl: 7 }, // 7 dots
  { pattern: /^\d+(?:\.\d+){6}\s+/, nodeType: 'pr5', normalizedIlvl: 6 }, // 6 dots
  { pattern: /^\d+(?:\.\d+){5}\s+/, nodeType: 'pr4', normalizedIlvl: 5 }, // 5 dots (1.2.3.4.5.6)
  { pattern: /^\d+(?:\.\d+){4}\s+/, nodeType: 'pr3', normalizedIlvl: 4 }, // 4 dots (N.N.N.N.N)
  { pattern: /^\d+(?:\.\d+){3}\s+/, nodeType: 'pr2', normalizedIlvl: 3 }, // 3 dots (N.N.N.N)
  { pattern: /^\d+(?:\.\d+){2}\s+/, nodeType: 'pr1', normalizedIlvl: 2 }, // 2 dots (N.N.N)
  { pattern: /^\d+\.\d+\s+/, nodeType: 'article', normalizedIlvl: 1 }, // 1 dot (N.N)
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
 * Returns true if the text is a literal "PART n" heading (e.g. "PART 1 – GENERAL").
 * Used by Signal 1 as a confirmation guard when ilvl=0, alongside the
 * specShapedNumIds numbering check, to keep generic numbered lists exported by
 * LibreOffice/Word from being misclassified as PART nodes.
 *
 * Bare canonical names ("GENERAL"/"PRODUCTS"/"EXECUTION") are deliberately NOT
 * matched here: a generic <ol> item at ilvl=0 whose text happens to be one of
 * those words would otherwise be promoted to a PART with no numbering evidence.
 * The real CPI bare-name case is recognized instead by its ilvl=0 "PART %1"
 * lvlText, which marks the numId spec-shaped — see findSpecShapedNumIds
 * (numbering.ts) and the Signal-1 guard (inference.ts).
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

// A horizontal rule made only of decoration chars (asterisks, dashes, equals,
// bullets) — 3+ so a stray "--" or "==" arrow isn't caught. Spaces allowed so
// spaced rules ("* * *") match; a trimmed non-empty match always holds a real
// decoration char.
const DECORATION_RULE = /^[\s*=•·—–-]{3,}$/;
// Strips decoration + brackets/parens so an "[OR]" / "OR" alternate-choice marker
// reduces to the bare token regardless of how it is wrapped ("****** [OR] ******").
const OR_DECORATION = /[\s*=•·—–[\]()-]/g;

/**
 * Returns true for editorial *separator* lines that are never structural content:
 * a decoration rule ("****", "----", "====") or an "[OR]"/"OR" alternate-choice
 * marker. These carry no hierarchy — a spec author inserts them between mutually
 * exclusive option blocks. Routing them to a continuation (before any signal runs)
 * is defense-in-depth: a separator that retained a PART-tier style AND live
 * numbering would otherwise be promoted to a spurious PART (the numId=0 guard only
 * catches the DE-numbered variant). Real content, orphan brackets ("]"), and
 * fill-in placeholders ("[__item__]") are deliberately NOT matched.
 */
export function isDecorationSeparator(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  if (DECORATION_RULE.test(trimmed)) return true;
  return trimmed.replace(OR_DECORATION, '').toUpperCase() === 'OR';
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
  // estimated <= 0 (a ≈0 or negative/hanging indent) is NOT positive evidence of the
  // top PART tier — unindented body text, headers, and preamble lines all sit at ~0.
  // Indentation only distinguishes article-and-deeper (ilvl >= 1); a real PART is set by
  // numbering, "PART n" text, or a part style, never by "not indented". Returning 0 here
  // let a negative-indent preamble ("SUMMARY OF CHANGE(S):", -86 twips → round → -0)
  // become a phantom PART. Also rejects the negative case the old `< 0` guard missed
  // (Math.round(-86/576) === -0, which is not < 0).
  if (estimated <= 0 || estimated > MAX_ILVL) return null;

  return estimated;
}
