// Strip a render-derived CSI "PART n -" prefix from a heading's text, leaving
// only the part name (e.g. "PART 3 - EXECUTION" → "EXECUTION", "PART 1 – GENERAL"
// → "GENERAL", "PART 2 PRODUCTS" → "PRODUCTS"). The "PART n -" label is
// reconstructed at render time (generator/markdown getLabel), so the canonical
// AST stores only the name — otherwise the label doubles to "PART 3 - PART 3 - …".
//
// Shared by every parser that emits PART headings (.SEC, text, DOCX): the same
// numbering can supply the prefix (bare-name text) or the author can bake it into
// the literal run text, and both must normalize to the same canonical name.
//
// Matches a hyphen, en-dash, or em-dash separator. Requires whitespace after
// "PART" so "PARTITION 1" is never mistaken for a part heading. Returns the
// trimmed remainder, which may be empty for a bare "PART n" with no name —
// callers decide the fallback (keep original, or a literal "PART").
const PART_PREFIX = /^PART\s+\d+\s*[-–—]?\s*/i;

export function stripPartPrefix(text: string): string {
  return text.replace(PART_PREFIX, '').trim();
}
