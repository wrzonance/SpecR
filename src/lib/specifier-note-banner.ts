// Contains-style mirror of the two anchored specifier-note banner patterns in
// src/parser/docx/heuristics.ts (isSpecifierNote). Used to detect a banner LEAKING
// into rendered body — so it must match anywhere in a line, not just at the start.
// KEEP IN SYNC with heuristics.ts and the migration-024 'Industry Default' seed
// (ADR-022 D3): if a banner variant is added there, add it here.
const NOTE_TO_SPECIFIER = /NOTES? TO (?:THE )?SPEC(?:IFIER|S| WRITER)?S?\b/;
const SPECIFIER_NOTES = /SPEC(?:IFIER)?S? NOTES?\b/;

/** True if the text contains a specifier-note banner in any decoration variant. */
export function containsSpecifierNoteBanner(text: string): boolean {
  const upper = text.toUpperCase();
  return NOTE_TO_SPECIFIER.test(upper) || SPECIFIER_NOTES.test(upper);
}
