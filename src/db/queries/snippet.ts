// Builds a short, human-readable snippet of the paragraph a cross-reference sits
// in — "the matched ref in context" for the coordination report's dangling_ref
// finding (issue #260). Pure and whitespace-normalised so the result reads as a
// single line regardless of the source paragraph's wrapping.

const ELLIPSIS = '…';

/** Chars of context kept on each side of the match before truncating. */
const CONTEXT_RADIUS = 60;

/** Paragraphs at or under this length are returned whole (no windowing). */
const WHOLE_TEXT_BUDGET = 160;

/** Collapse runs of whitespace (incl. newlines/tabs) to single spaces and trim. */
function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * @param paragraphText full text of the source paragraph
 * @param referenceText the matched cross-reference, used to centre the window
 */
export function buildSnippet(paragraphText: string, referenceText: string): string {
  const text = normaliseWhitespace(paragraphText);
  if (text.length <= WHOLE_TEXT_BUDGET) {
    return text;
  }

  const needle = normaliseWhitespace(referenceText);
  const matchIndex = text.toLowerCase().indexOf(needle.toLowerCase());
  if (matchIndex < 0) {
    // reference_text and paragraph text are stored independently; on a mismatch
    // fall back to a readable head excerpt rather than returning nothing.
    return `${text.slice(0, WHOLE_TEXT_BUDGET).trimEnd()}${ELLIPSIS}`;
  }

  const start = Math.max(0, matchIndex - CONTEXT_RADIUS);
  const end = Math.min(text.length, matchIndex + needle.length + CONTEXT_RADIUS);
  const core = text.slice(start, end).trim();
  const lead = start > 0 ? ELLIPSIS : '';
  const trail = end < text.length ? ELLIPSIS : '';
  return `${lead}${core}${trail}`;
}
